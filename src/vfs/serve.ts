/**
 * Virtual HTTP serving, independent of the Service Worker that hosts it.
 *
 * This module knows how to turn a URL into a Response backed by a
 * `FileSystemDirectoryHandle`: path parsing, range handling, status codes,
 * content types. It knows nothing about Zarr — that is deliberate, and it is
 * what lets Neuroglancer and Zarrcade share one namespace unmodified — and
 * nothing about IndexedDB or worker lifecycle, which keeps it testable and
 * keeps `sw.ts` down to event wiring.
 */
import { SW_VERSION } from './protocol';

export interface ParsedPath {
  /** First segment after the namespace prefix: mount id or session id. */
  id: string;
  /** Remaining decoded segments; empty when the URL targets the root. */
  segments: string[];
  /** True when the URL ended in `/`, i.e. it names a directory. */
  trailingSlash: boolean;
}

/**
 * Split `<prefix><id>/a/b/c` into its parts, rejecting anything that could
 * escape the mount root. Returns null for a malformed path.
 */
export function parsePath(pathname: string, prefix: string): ParsedPath | null {
  if (!pathname.startsWith(prefix)) return null;

  const rest = pathname.slice(prefix.length);
  if (rest === '') return null;

  const trailingSlash = rest.endsWith('/');
  const rawParts = rest.split('/').filter((part) => part !== '');
  if (rawParts.length === 0) return null;

  const decoded: string[] = [];
  for (const part of rawParts) {
    let value: string;
    try {
      value = decodeURIComponent(part);
    } catch {
      return null;
    }
    // `.` and `..` never appear in a legitimate Zarr key, and honouring them
    // would let a crafted URL read outside the mounted directory.
    if (value === '.' || value === '..' || value.includes('/') || value.includes('\0')) {
      return null;
    }
    decoded.push(value);
  }

  const [id, ...segments] = decoded;
  return { id, segments, trailingSlash };
}

/* --------------------------------------------------------- handle probing */

export function isNotFound(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'NotFoundError';
}

export function isTypeMismatch(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'TypeMismatchError';
}

export function isNotAllowed(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'NotAllowedError';
}

export type Resolved =
  | { kind: 'file'; file: File }
  | { kind: 'directory' }
  | { kind: 'missing' };

/**
 * Walk `segments` from `root`, returning the file they name.
 *
 * `resolveDirectory` is injected so the worker can cache intermediate handles
 * — a chunked Zarr array issues thousands of requests sharing a long prefix,
 * and re-walking it every time is the difference between smooth and unusable.
 */
export async function resolveFile(
  root: FileSystemDirectoryHandle,
  segments: string[],
  resolveDirectory: (
    root: FileSystemDirectoryHandle,
    segments: string[],
  ) => Promise<FileSystemDirectoryHandle | null> = defaultResolveDirectory,
): Promise<Resolved> {
  if (segments.length === 0) return { kind: 'directory' };

  const parent = await resolveDirectory(root, segments.slice(0, -1));
  if (parent === null) return { kind: 'missing' };

  const name = segments[segments.length - 1];
  try {
    const handle = await parent.getFileHandle(name);
    return { kind: 'file', file: await handle.getFile() };
  } catch (error) {
    if (isTypeMismatch(error)) return { kind: 'directory' };
    if (isNotFound(error)) return { kind: 'missing' };
    throw error;
  }
}

export async function defaultResolveDirectory(
  root: FileSystemDirectoryHandle,
  segments: string[],
): Promise<FileSystemDirectoryHandle | null> {
  let handle = root;
  for (const segment of segments) {
    try {
      handle = await handle.getDirectoryHandle(segment);
    } catch (error) {
      if (isNotFound(error) || isTypeMismatch(error)) return null;
      throw error;
    }
  }
  return handle;
}

/* ---------------------------------------------------------- content types */

const CONTENT_TYPES: Record<string, string> = {
  json: 'application/json',
  zattrs: 'application/json',
  zarray: 'application/json',
  zgroup: 'application/json',
  zmetadata: 'application/json',
  csv: 'text/csv; charset=utf-8',
  tsv: 'text/tab-separated-values; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  md: 'text/plain; charset=utf-8',
  xml: 'application/xml',
  html: 'text/html; charset=utf-8',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  tif: 'image/tiff',
  tiff: 'image/tiff',
};

/**
 * Guess a content type from a file name. Zarr chunk files have no extension at
 * all, so the opaque-bytes fallback is the common case.
 */
export function contentTypeFor(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot > 0) {
    const extension = name.slice(dot + 1).toLowerCase();
    if (extension in CONTENT_TYPES) return CONTENT_TYPES[extension];
  }
  // `.zattrs` and friends are dotfiles: the name starts with the dot.
  const bare = name.startsWith('.') ? name.slice(1).toLowerCase() : '';
  if (bare in CONTENT_TYPES) return CONTENT_TYPES[bare];
  return 'application/octet-stream';
}

/* ------------------------------------------------------------- responses */

export function baseHeaders(extra?: Record<string, string>): Headers {
  return new Headers({
    'Accept-Ranges': 'bytes',
    // The bytes come from a live file the user may overwrite, and a cache
    // entry would outlive the mount it belongs to.
    'Cache-Control': 'no-store',
    'X-Local-Server': `ome-zarr-portal/${SW_VERSION}`,
    ...extra,
  });
}

export function errorResponse(
  status: number,
  message: string,
  extra?: Record<string, string>,
): Response {
  return new Response(message, {
    status,
    headers: baseHeaders({ 'Content-Type': 'text/plain; charset=utf-8', ...extra }),
  });
}

export interface ParsedRange {
  start: number;
  end: number;
}

/**
 * Parse a single-range `Range: bytes=...` header against a known size.
 *
 * Returns `null` when the header is absent or asks for something we choose to
 * answer with a full body — multiple ranges or an unknown unit. RFC 9110 lets
 * a server ignore Range entirely, so a 200 is always a valid answer, and
 * neither viewer needs multipart responses. `'unsatisfiable'` means the range
 * lies outside the file and the caller must answer 416.
 */
export function parseRange(
  header: string | null,
  size: number,
): ParsedRange | null | 'unsatisfiable' {
  if (!header) return null;

  const match = /^bytes=(.*)$/i.exec(header.trim());
  if (!match) return null;

  const spec = match[1].trim();
  if (spec.includes(',')) return null;

  const parts = /^(\d*)-(\d*)$/.exec(spec);
  if (!parts) return null;

  const [, rawStart, rawEnd] = parts;

  if (rawStart === '') {
    // `bytes=-N`: the final N bytes.
    if (rawEnd === '') return null;
    const suffix = Number(rawEnd);
    if (suffix === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - suffix), end: Math.max(0, size - 1) };
  }

  const start = Number(rawStart);
  if (start >= size) return 'unsatisfiable';
  const end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1);
  if (end < start) return 'unsatisfiable';
  return { start, end };
}

/**
 * Build a response for a blob, honouring Range and HEAD.
 *
 * `Content-Length` is always set explicitly: a HEAD response has no body to
 * infer it from, and Neuroglancer's HTTP key-value store reads it when sizing
 * reads into sharded arrays.
 */
export function serveBlob(
  request: Request,
  blob: Blob,
  contentType: string,
  extra?: Record<string, string>,
): Response {
  const size = blob.size;
  const range = parseRange(request.headers.get('Range'), size);

  if (range === 'unsatisfiable') {
    return errorResponse(416, 'Range Not Satisfiable', {
      'Content-Range': `bytes */${size}`,
      ...extra,
    });
  }

  const isHead = request.method === 'HEAD';

  if (range) {
    const length = range.end - range.start + 1;
    return new Response(isHead ? null : blob.slice(range.start, range.end + 1), {
      status: 206,
      statusText: 'Partial Content',
      headers: baseHeaders({
        'Content-Type': contentType,
        'Content-Length': String(length),
        'Content-Range': `bytes ${range.start}-${range.end}/${size}`,
        ...extra,
      }),
    });
  }

  return new Response(isHead ? null : blob, {
    status: 200,
    headers: baseHeaders({
      'Content-Type': contentType,
      'Content-Length': String(size),
      ...extra,
    }),
  });
}

/* --------------------------------------------------------------- handlers */

export interface LocalServeOptions {
  prefix: string;
  lookupMount: (mountId: string) => Promise<{ id: string; handle: FileSystemDirectoryHandle } | null>;
  resolveDirectory?: (
    root: FileSystemDirectoryHandle,
    segments: string[],
  ) => Promise<FileSystemDirectoryHandle | null>;
}

/** Serve a request under the `_local/` namespace. */
export async function serveLocal(
  request: Request,
  url: URL,
  options: LocalServeOptions,
): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return errorResponse(405, 'Method Not Allowed', { Allow: 'GET, HEAD' });
  }

  const parsed = parsePath(url.pathname, options.prefix);
  if (!parsed) return errorResponse(400, 'Bad local path');

  const mount = await options.lookupMount(parsed.id);
  if (!mount) {
    return errorResponse(404, `No mount "${parsed.id}". Drop the folder on the portal again.`, {
      'X-Local-Error': 'unknown-mount',
    });
  }

  let resolved: Resolved;
  try {
    resolved = await resolveFile(mount.handle, parsed.segments, options.resolveDirectory);
  } catch (error) {
    if (isNotAllowed(error)) {
      // The handle outlived its permission grant, typically after a reload.
      return errorResponse(
        403,
        'Read permission for this folder was not granted. Drop the folder on the portal again.',
        { 'X-Local-Error': 'permission-lost' },
      );
    }
    return errorResponse(500, `Error reading local file: ${String(error)}`);
  }

  if (resolved.kind === 'missing') {
    return errorResponse(404, 'Not Found', { 'X-Local-Error': 'not-found' });
  }
  if (resolved.kind === 'directory') {
    // Zarr never needs a listing and neither viewer asks for one. Answering
    // 404 keeps the namespace's contract simple: only files exist.
    return errorResponse(404, 'Not Found (path is a directory)', {
      'X-Local-Error': 'is-directory',
    });
  }
  if (parsed.trailingSlash) {
    return errorResponse(404, 'Not Found (path is a file, but the URL ends in "/")', {
      'X-Local-Error': 'not-found',
    });
  }

  const { file } = resolved;
  return serveBlob(request, file, contentTypeFor(file.name), {
    'Last-Modified': new Date(file.lastModified).toUTCString(),
    'X-Local-Mount': mount.id,
  });
}

export interface SessionServeOptions {
  prefix: string;
  lookupFile: (key: string) => Promise<{ body: string; contentType: string } | null>;
}

/** Serve a request under the `_session/` namespace. */
export async function serveSession(
  request: Request,
  url: URL,
  options: SessionServeOptions,
): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return errorResponse(405, 'Method Not Allowed', { Allow: 'GET, HEAD' });
  }

  const parsed = parsePath(url.pathname, options.prefix);
  if (!parsed || parsed.segments.length === 0) return errorResponse(400, 'Bad session path');

  const record = await options.lookupFile(`${parsed.id}/${parsed.segments.join('/')}`);
  if (!record) return errorResponse(404, 'Not Found', { 'X-Local-Error': 'not-found' });

  return serveBlob(request, new Blob([record.body]), record.contentType);
}

export interface PreviewServeOptions {
  prefix: string;
  lookupMount: (mountId: string) => Promise<{ id: string; handle: FileSystemDirectoryHandle } | null>;
  /** Produce a PNG for an image, or throw if one cannot be made. */
  render: (mountId: string, relativePath: string) => Promise<Blob>;
}

/**
 * Serve a request under the `_preview/` namespace.
 *
 * Every failure — an unknown mount, an image with no resolution levels, one too
 * large to project, a codec we cannot decode, no page available to render —
 * is answered with 404. That is
 * deliberate: Zarrcade's image `onerror` handler falls back to its placeholder
 * icon, so an unavailable preview degrades to "no preview" with no special
 * handling on either side.
 */
export async function servePreview(
  request: Request,
  url: URL,
  options: PreviewServeOptions,
): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return errorResponse(405, 'Method Not Allowed', { Allow: 'GET, HEAD' });
  }

  const parsed = parsePath(url.pathname, options.prefix);
  if (!parsed) return errorResponse(400, 'Bad preview path');

  const mount = await options.lookupMount(parsed.id);
  if (!mount) {
    return errorResponse(404, 'Not Found', { 'X-Local-Error': 'unknown-mount' });
  }

  let png: Blob;
  try {
    png = await options.render(mount.id, parsed.segments.join('/'));
  } catch (error) {
    return errorResponse(404, `No preview available: ${String(error)}`, {
      'X-Local-Error': 'no-preview',
    });
  }

  return serveBlob(request, png, 'image/png', {
    // Derived, deterministic and cheap to re-request, but re-rendering on
    // every scroll would be wasteful. A short private cache is a good trade.
    'Cache-Control': 'private, max-age=300',
    'X-Local-Mount': mount.id,
  });
}
