/**
 * Service Worker hosting the virtual local-file namespace.
 *
 * The portal mounts dropped directories as `FileSystemDirectoryHandle`s and
 * stores them in IndexedDB. This worker reads those handles directly and
 * answers same-origin HTTP requests:
 *
 *   GET|HEAD <base>_local/<mount-id>/<relative-path>  -> bytes from the disk
 *   GET|HEAD <base>_session/<session-id>/<name>       -> a generated document
 *
 * Nothing is copied into OPFS or any other browser storage: every request
 * slices the live `File`. The HTTP semantics live in `serve.ts`; what remains
 * here is lifecycle, storage lookup, and the handle caching that makes
 * chunk-heavy access fast.
 */
/// <reference lib="webworker" />
import { idbGet } from './idb';
import {
  LOCAL_SEGMENT,
  MOUNT_STORE,
  namespacePrefix,
  PREVIEW_SEGMENT,
  SESSION_SEGMENT,
  SESSION_STORE,
  type MountRecord,
  type PortalMessage,
  type SessionFileRecord,
} from './protocol';
import { isNotFound, isTypeMismatch, serveLocal, servePreview, serveSession } from './serve';

// `self` is typed as `Window` because the project's `lib` includes DOM; cast
// rather than redeclare so DOM types stay available to shared modules.
const sw = self as unknown as ServiceWorkerGlobalScope;

/**
 * The path this worker controls, e.g. `/` or `/ome-zarr-portal/`. Taking it
 * from the registration scope rather than a build-time constant is what lets
 * a single build be deployed at any subpath, GitHub Pages included.
 */
const BASE_PATH = new URL(sw.registration.scope).pathname;
const LOCAL_PREFIX = namespacePrefix(BASE_PATH, LOCAL_SEGMENT);
const SESSION_PREFIX = namespacePrefix(BASE_PATH, SESSION_SEGMENT);
const PREVIEW_PREFIX = namespacePrefix(BASE_PATH, PREVIEW_SEGMENT);

sw.addEventListener('install', () => {
  // Take over immediately: a freshly dropped folder should be readable without
  // the user having to reload the page first.
  void sw.skipWaiting();
});

sw.addEventListener('activate', (event) => {
  event.waitUntil(sw.clients.claim());
});

sw.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== sw.location.origin) return;

  if (url.pathname.startsWith(LOCAL_PREFIX)) {
    event.respondWith(
      serveLocal(event.request, url, {
        prefix: LOCAL_PREFIX,
        lookupMount: getMount,
        resolveDirectory: resolveDirectoryCached,
      }),
    );
  } else if (url.pathname.startsWith(SESSION_PREFIX)) {
    event.respondWith(
      serveSession(event.request, url, {
        prefix: SESSION_PREFIX,
        lookupFile: getSessionFile,
      }),
    );
  } else if (url.pathname.startsWith(PREVIEW_PREFIX)) {
    event.respondWith(
      servePreview(event.request, url, {
        prefix: PREVIEW_PREFIX,
        lookupMount: getMount,
        render: renderCachedPreview,
      }),
    );
  }
});

sw.addEventListener('message', (event) => {
  const message = event.data as PortalMessage | undefined;
  if (!message) return;

  if (message.type === 'ping') {
    event.source?.postMessage({ type: 'pong' });
  } else if (message.type === 'flush') {
    if (message.mountId) {
      mountCache.delete(message.mountId);
      for (const key of [...directoryCache.keys()]) {
        if (key === message.mountId || key.startsWith(`${message.mountId}/`)) {
          directoryCache.delete(key);
        }
      }
      for (const key of [...previewCache.keys()]) {
        if (key.startsWith(`${message.mountId}/`)) previewCache.delete(key);
      }
    } else {
      mountCache.clear();
      directoryCache.clear();
      previewCache.clear();
    }
  }
});

/* ------------------------------------------------------------ persistence */

async function getMount(mountId: string): Promise<MountRecord | null> {
  const cached = mountCache.get(mountId);
  if (cached !== undefined) return cached;
  const record = (await idbGet<MountRecord>(MOUNT_STORE, mountId)) ?? null;
  mountCache.set(mountId, record);
  return record;
}

async function getSessionFile(
  key: string,
): Promise<{ body: string; contentType: string } | null> {
  const record = await idbGet<SessionFileRecord>(SESSION_STORE, key);
  return record ? { body: record.body, contentType: record.contentType } : null;
}

/* ------------------------------------------------------------------ cache */

/**
 * Resolving `<base>_local/<id>/a/b/c/chunk` walks one directory handle per
 * segment, and a chunked Zarr array issues thousands of requests sharing a
 * long prefix. Caching handles collapses that walk to a single lookup for all
 * but the last segment.
 *
 * Entries are invalidated only on unmount, so a folder restructured on disk
 * mid-session may need a reload. That trade is deliberate: correctness under
 * concurrent edits is worth much less here than throughput.
 */
const mountCache = new Map<string, MountRecord | null>();
const directoryCache = new Map<string, Promise<FileSystemDirectoryHandle | null>>();
const DIRECTORY_CACHE_LIMIT = 4096;

/** Path segments cannot contain "/", so joining on it is unambiguous. */
function cacheKey(mountId: string, segments: string[]): string {
  return [mountId, ...segments].join('/');
}

function rememberDirectory(
  key: string,
  value: Promise<FileSystemDirectoryHandle | null>,
): void {
  if (directoryCache.size >= DIRECTORY_CACHE_LIMIT) {
    // Maps iterate in insertion order, so this evicts the oldest entries.
    let remaining = Math.ceil(DIRECTORY_CACHE_LIMIT / 4);
    for (const oldest of directoryCache.keys()) {
      directoryCache.delete(oldest);
      if (--remaining <= 0) break;
    }
  }
  directoryCache.set(key, value);
}

/**
 * Walk to a directory, caching every prefix along the way.
 *
 * The mount id is recovered from the root handle so cache keys can be scoped
 * per mount; `serveLocal` passes the root handle, not the record.
 */
async function resolveDirectoryCached(
  root: FileSystemDirectoryHandle,
  segments: string[],
): Promise<FileSystemDirectoryHandle | null> {
  const mountId = mountIdFor(root);
  let handle: FileSystemDirectoryHandle = root;

  for (let index = 0; index < segments.length; index += 1) {
    const key = cacheKey(mountId, segments.slice(0, index + 1));
    const cached = directoryCache.get(key);
    if (cached !== undefined) {
      const resolved = await cached;
      if (resolved === null) return null;
      handle = resolved;
      continue;
    }

    const parent = handle;
    const segment = segments[index];
    const pending = (async (): Promise<FileSystemDirectoryHandle | null> => {
      try {
        return await parent.getDirectoryHandle(segment);
      } catch (error) {
        if (isNotFound(error) || isTypeMismatch(error)) return null;
        throw error;
      }
    })();
    rememberDirectory(key, pending);

    const resolved = await pending;
    if (resolved === null) return null;
    handle = resolved;
  }

  return handle;
}

/** Reverse lookup from a cached mount's root handle to its id. */
function mountIdFor(root: FileSystemDirectoryHandle): string {
  for (const [id, record] of mountCache) {
    if (record && record.handle === root) return id;
  }
  return '?';
}

/* --------------------------------------------------------------- previews */

/**
 * Rendered previews, keyed by mount and dataset path.
 *
 * Zarrcade preloads the thumbnail for every card on a page at once — 50 by
 * default — and re-renders them on pagination and filtering. Sharing the
 * in-flight promise means duplicate requests cost nothing, and keeping the
 * result means scrolling back is free.
 */
const previewCache = new Map<string, Promise<Blob>>();
const PREVIEW_CACHE_LIMIT = 128;

/** How long to wait for a page to render one preview before giving up. */
const RENDER_TIMEOUT_MS = 30000;

/**
 * Ask a controlled page to render a preview.
 *
 * This worker cannot do it itself: rendering needs zarrita's WASM codecs,
 * which a service worker can only obtain by bundling them in eagerly, since it
 * cannot `import()` lazily. That would add 1.4 MB to the script that serves
 * every chunk Neuroglancer reads. So the work goes to a page, which can load
 * them on demand in a dedicated worker.
 *
 * The request is broadcast to every window client; only a portal page has a
 * handler for it, and the first reply wins. When no portal page is open — a
 * gallery left in a tab of its own, say — nothing replies and the timeout
 * turns into a 404, which the gallery renders as its placeholder icon.
 */
async function requestPreviewFromClient(mountId: string, relativePath: string): Promise<Blob> {
  const clients = await sw.clients.matchAll({ type: 'window' });
  if (clients.length === 0) {
    throw new Error('no page is open to render previews');
  }

  return new Promise<Blob>((resolve, reject) => {
    let settled = false;
    let refusals = 0;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('preview render timed out'));
    }, RENDER_TIMEOUT_MS);

    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      action();
    };

    for (const client of clients) {
      const channel = new MessageChannel();
      channel.port1.onmessage = (event: MessageEvent) => {
        const reply = event.data as { ok?: boolean; png?: ArrayBuffer; error?: string };
        if (reply?.ok && reply.png) {
          finish(() => resolve(new Blob([reply.png!], { type: 'image/png' })));
        } else if (++refusals >= clients.length) {
          finish(() => reject(new Error(reply?.error ?? 'no page could render this preview')));
        }
      };
      client.postMessage({ type: 'render-preview', mountId, relativePath }, [channel.port2]);
    }
  });
}

async function renderCachedPreview(mountId: string, relativePath: string): Promise<Blob> {
  const key = `${mountId}/${relativePath}`;
  const cached = previewCache.get(key);
  if (cached) return cached;

  const pending = requestPreviewFromClient(mountId, relativePath);
  // A failure is often permanent (too large, unsupported codec) but can also be
  // transient (no page open yet), so drop it rather than caching a rejection.
  pending.catch(() => previewCache.delete(key));

  if (previewCache.size >= PREVIEW_CACHE_LIMIT) {
    const oldest = previewCache.keys().next();
    if (!oldest.done) previewCache.delete(oldest.value);
  }
  previewCache.set(key, pending);
  return pending;
}
