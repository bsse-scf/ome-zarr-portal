/**
 * Recursive OME-Zarr discovery.
 *
 * Given mounted directories, find every multiscale OME-Zarr image below them
 * and return a normalized list with same-origin URLs. The traversal is
 * format-driven rather than name-driven: a `.ome.zarr` suffix is a convention,
 * not a guarantee, and plenty of valid datasets do not use it.
 *
 * Two rules keep the walk correct and cheap:
 *
 *  1. A group carrying `multiscales` IS the dataset. The walk stops there, so
 *     the resolution levels beneath it are never mistaken for datasets of
 *     their own.
 *  2. A Zarr array is never descended into. Its children are chunk files and
 *     chunk directories, and enumerating them could mean millions of entries.
 */
import type { Mount } from '../mounts/registry';
import { localUrl } from '../vfs/client';
import { axisRoles, isPreviewable } from '../preview/policy';
import {
  hasThumbnailsConvention,
  isBioformats2RawLayout,
  isPlate,
  readArrayInfo,
  readJsonFile,
  readMultiscale,
  readZarrNode,
  type MultiscaleInfo,
  type ZarrNode,
} from './zarr-metadata';
import {
  DEFAULT_LIMITS,
  type DiscoveredDataset,
  type DiscoveryLimits,
  type DiscoveryNote,
  type DiscoveryOptions,
  type DiscoveryResult,
} from './types';

/** Entries that are never part of a Zarr hierarchy. */
const IGNORED_NAMES = new Set(['__MACOSX', '.DS_Store', 'Thumbs.db', '.git']);

function isIgnored(name: string): boolean {
  // Dotfiles are skipped as directories, but Zarr v2's own `.zgroup`/`.zattrs`
  // are files and are read by name, so nothing needed is lost here.
  return IGNORED_NAMES.has(name) || name.startsWith('.');
}

function ensureTrailingSlash(url: string): string {
  return url.endsWith('/') ? url : `${url}/`;
}

function displayName(relativePath: string, mount: Mount, multiscale: MultiscaleInfo): string {
  const base = relativePath === '' ? mount.name : relativePath.slice(relativePath.lastIndexOf('/') + 1);
  const stripped = base.replace(/\.ome\.zarr$/i, '').replace(/\.zarr$/i, '');
  return stripped || multiscale.name || base || 'Untitled';
}

/** Location shown to the user in notes and in the gallery. */
function displayPath(relativePath: string, mount: Mount): string {
  return relativePath === '' ? mount.name : `${mount.name}/${relativePath}`;
}

interface WalkContext {
  mount: Mount;
  buildUrl: (mountId: string, relativePath: string) => string;
  limits: DiscoveryLimits;
  datasets: DiscoveredDataset[];
  notes: DiscoveryNote[];
  directoriesScanned: number;
  limitReported: Set<string>;
  options: DiscoveryOptions;
}

function note(context: WalkContext, note: DiscoveryNote): void {
  context.notes.push(note);
}

/** Report a limit at most once per kind, so notes stay readable. */
function reportLimit(context: WalkContext, key: string, message: string): void {
  if (context.limitReported.has(key)) return;
  context.limitReported.add(key);
  note(context, { kind: 'limit', path: context.mount.name, message });
}

/**
 * Read one pyramid level's array metadata.
 *
 * Best-effort: this is display metadata for the gallery, so any failure is
 * swallowed rather than turned into a note the user cannot act on.
 */
async function readLevelInfo(
  directory: FileSystemDirectoryHandle,
  levelPath: string,
  format: 2 | 3,
): Promise<{ shape?: number[]; dtype?: string }> {
  try {
    let current = directory;
    for (const segment of levelPath.split('/').filter(Boolean)) {
      current = await current.getDirectoryHandle(segment);
    }
    const raw =
      format === 3
        ? await readJsonFile(current, 'zarr.json')
        : await readJsonFile(current, '.zarray');
    return raw ? readArrayInfo(raw) : {};
  } catch {
    return {};
  }
}

/**
 * Decide whether a preview can be projected from the coarsest level.
 *
 * Reads only that level's metadata — never its data — so an ineligible dataset
 * costs one small JSON read and is simply left without a preview.
 */
async function checkPreviewable(
  directory: FileSystemDirectoryHandle,
  multiscale: MultiscaleInfo,
  format: 2 | 3,
): Promise<boolean> {
  const coarsest = multiscale.paths[multiscale.paths.length - 1];
  if (!coarsest) return false;

  const { shape, dtype } = await readLevelInfo(directory, coarsest, format);
  if (!shape || shape.length < 2) return false;

  return isPreviewable(shape, axisRoles(multiscale.axes, shape.length), dtype);
}

async function recordDataset(
  context: WalkContext,
  directory: FileSystemDirectoryHandle,
  relativePath: string,
  node: Extract<ZarrNode, { kind: 'group' }>,
  multiscale: MultiscaleInfo,
): Promise<void> {
  const { mount } = context;
  const finest = multiscale.paths[0];
  const { shape, dtype } = finest
    ? await readLevelInfo(directory, finest, node.format)
    : {};

  const hasConventionThumbnail = hasThumbnailsConvention(node);
  // A dataset that ships its own thumbnails needs no preview from us, so skip
  // the extra metadata read entirely.
  const previewable = hasConventionThumbnail
    ? false
    : await checkPreviewable(directory, multiscale, node.format);

  context.datasets.push({
    id: `${mount.id}:${relativePath || '.'}`,
    name: displayName(relativePath, mount, multiscale),
    relativePath,
    virtualUrl: ensureTrailingSlash(context.buildUrl(mount.id, relativePath)),
    omeZarrVersion: multiscale.version,
    mountId: mount.id,
    mountName: mount.name,
    zarrFormat: node.format,
    axes: multiscale.axes,
    shape,
    dtype,
    scaleCount: multiscale.paths.length || undefined,
    hasConventionThumbnail,
    previewable,
  });
}

/** List child directories, honouring the per-directory cap. */
async function childDirectories(
  context: WalkContext,
  directory: FileSystemDirectoryHandle,
  relativePath: string,
): Promise<FileSystemDirectoryHandle[]> {
  const children: FileSystemDirectoryHandle[] = [];
  let seen = 0;

  for await (const entry of directory.values()) {
    if (++seen > context.limits.maxEntriesPerDirectory) {
      note(context, {
        kind: 'limit',
        path: displayPath(relativePath, context.mount),
        message: `Stopped after ${context.limits.maxEntriesPerDirectory} entries in this folder.`,
      });
      break;
    }
    if (entry.kind !== 'directory' || isIgnored(entry.name)) continue;
    children.push(entry);
  }

  // Stable, human order: `0, 1, 2, 10` rather than `0, 1, 10, 2`.
  children.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  return children;
}

async function walk(
  context: WalkContext,
  directory: FileSystemDirectoryHandle,
  relativePath: string,
  depth: number,
): Promise<void> {
  context.options.signal?.throwIfAborted();

  if (context.datasets.length >= context.limits.maxDatasets) {
    reportLimit(
      context,
      'datasets',
      `Stopped after ${context.limits.maxDatasets} datasets; the folder contains more.`,
    );
    return;
  }
  if (context.directoriesScanned >= context.limits.maxDirectories) {
    reportLimit(
      context,
      'directories',
      `Stopped after scanning ${context.limits.maxDirectories} folders.`,
    );
    return;
  }

  context.directoriesScanned += 1;
  context.options.onProgress?.({
    directoriesScanned: context.directoriesScanned,
    datasetsFound: context.datasets.length,
    currentPath: displayPath(relativePath, context.mount),
  });

  let node: ZarrNode;
  try {
    node = await readZarrNode(directory);
  } catch (error) {
    note(context, {
      kind: 'error',
      path: displayPath(relativePath, context.mount),
      message: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  if (node.kind === 'array') {
    // Rule 2. At the top level this is worth reporting, because the user
    // pointed at it deliberately; deeper down it is just a resolution level.
    if (depth === 0) {
      note(context, {
        kind: 'unsupported',
        path: displayPath(relativePath, context.mount),
        message:
          'This is a bare Zarr array, not an OME-Zarr multiscale image. Drop the group that contains it.',
      });
    }
    return;
  }

  if (node.kind === 'group') {
    const multiscale = readMultiscale(node);
    if (multiscale) {
      // Rule 1.
      await recordDataset(context, directory, relativePath, node, multiscale);
      return;
    }

    if (isPlate(node)) {
      // A plate is not itself openable as an image, but the field-of-view
      // images inside it are, so keep walking and say what we did.
      note(context, {
        kind: 'skipped',
        path: displayPath(relativePath, context.mount),
        message: 'HCS plate: listing the images inside it individually.',
      });
    } else if (isBioformats2RawLayout(node)) {
      note(context, {
        kind: 'skipped',
        path: displayPath(relativePath, context.mount),
        message: 'bioformats2raw container: listing its image series individually.',
      });
    }
    // Any other group — a well, a plain container — falls through to the
    // recursion below, which is how nested datasets are found.
  }

  if (depth >= context.limits.maxDepth) {
    reportLimit(
      context,
      'depth',
      `Stopped at ${context.limits.maxDepth} folders deep; deeper datasets were not searched.`,
    );
    return;
  }

  let children: FileSystemDirectoryHandle[];
  try {
    children = await childDirectories(context, directory, relativePath);
  } catch (error) {
    note(context, {
      kind: 'error',
      path: displayPath(relativePath, context.mount),
      message: `Could not list this folder: ${error instanceof Error ? error.message : String(error)}`,
    });
    return;
  }

  for (const child of children) {
    const childPath = relativePath === '' ? child.name : `${relativePath}/${child.name}`;
    await walk(context, child, childPath, depth + 1);
  }
}

/** Discover datasets in a single mount. */
export async function discoverInMount(
  mount: Mount,
  options: DiscoveryOptions = {},
): Promise<DiscoveryResult> {
  const context: WalkContext = {
    mount,
    buildUrl: options.urlBuilder ?? localUrl,
    limits: { ...DEFAULT_LIMITS, ...options.limits },
    datasets: [],
    notes: [],
    directoriesScanned: 0,
    limitReported: new Set(),
    options,
  };

  try {
    await walk(context, mount.handle, '', 0);
  } catch (error) {
    if (options.signal?.aborted) throw error;
    context.notes.push({
      kind: 'error',
      path: mount.name,
      message: error instanceof Error ? error.message : String(error),
    });
  }

  return {
    datasets: context.datasets,
    notes: context.notes,
    directoriesScanned: context.directoriesScanned,
  };
}

/**
 * Discover datasets across several mounts, accumulating progress so a drop of
 * multiple folders reads as one operation.
 */
export async function discoverInMounts(
  mounts: Mount[],
  options: DiscoveryOptions = {},
): Promise<DiscoveryResult> {
  const datasets: DiscoveredDataset[] = [];
  const notes: DiscoveryNote[] = [];
  let directoriesScanned = 0;

  for (const mount of mounts) {
    const result = await discoverInMount(mount, {
      ...options,
      onProgress: options.onProgress
        ? (progress) =>
            options.onProgress?.({
              directoriesScanned: directoriesScanned + progress.directoriesScanned,
              datasetsFound: datasets.length + progress.datasetsFound,
              currentPath: progress.currentPath,
            })
        : undefined,
    });
    datasets.push(...result.datasets);
    notes.push(...result.notes);
    directoriesScanned += result.directoriesScanned;
  }

  return { datasets, notes, directoriesScanned };
}
