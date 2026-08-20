/**
 * Reading and interpreting Zarr / OME-Zarr metadata from a directory handle.
 *
 * Kept separate from the traversal so the rules about "what counts as an
 * image" are in one readable place. Handles both layouts in current use:
 *
 *   OME-Zarr v4 and earlier: `.zgroup` / `.zarray` / `.zattrs`, with
 *     `multiscales` at the top level of `.zattrs`.
 *   OME-Zarr v5: a single `zarr.json` whose `node_type` says
 *     group or array, with `multiscales` nested under `attributes.ome`.
 */
import type { OmeZarrLayout } from './types';

export type JsonObject = Record<string, unknown>;

export type ZarrNode =
  | { kind: 'array'; layout: OmeZarrLayout }
  | { kind: 'group'; layout: OmeZarrLayout; attributes: JsonObject }
  /** No Zarr metadata here: an ordinary directory. */
  | { kind: 'none' };

export class MetadataError extends Error {}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read and parse a JSON file, returning undefined when it does not exist.
 *
 * A missing file is the normal way to probe for a layout, but a file that
 * exists and does not parse is a real problem worth surfacing.
 */
export async function readJsonFile(
  directory: FileSystemDirectoryHandle,
  name: string,
): Promise<JsonObject | undefined> {
  let file: File;
  try {
    const handle = await directory.getFileHandle(name);
    file = await handle.getFile();
  } catch (error) {
    if (error instanceof DOMException && (error.name === 'NotFoundError' || error.name === 'TypeMismatchError')) {
      return undefined;
    }
    throw error;
  }

  const text = await file.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new MetadataError(`${name} is not valid JSON: ${(error as Error).message}`);
  }
  if (!isObject(parsed)) {
    throw new MetadataError(`${name} does not contain a JSON object`);
  }
  return parsed;
}

/**
 * Classify a directory as a Zarr array, a Zarr group, or neither.
 *
 * Probing by name is deliberate: it costs at most three failed lookups per
 * directory and never enumerates entries, which matters because an array's
 * chunk directory can hold millions of files.
 */
export async function readZarrNode(directory: FileSystemDirectoryHandle): Promise<ZarrNode> {
  const v3 = await readJsonFile(directory, 'zarr.json');
  if (v3) {
    // `node_type` is required by the v5 layout; default to group for tolerance.
    const nodeType = typeof v3.node_type === 'string' ? v3.node_type : 'group';
    if (nodeType === 'array') return { kind: 'array', layout: 'v5' };
    const attributes = isObject(v3.attributes) ? v3.attributes : {};
    return { kind: 'group', layout: 'v5', attributes };
  }

  if (await readJsonFile(directory, '.zarray')) {
    return { kind: 'array', layout: 'v4' };
  }

  const zgroup = await readJsonFile(directory, '.zgroup');
  const zattrs = await readJsonFile(directory, '.zattrs');
  if (zgroup || zattrs) {
    return { kind: 'group', layout: 'v4', attributes: zattrs ?? {} };
  }

  return { kind: 'none' };
}

/**
 * The attribute bag OME metadata lives in.
 *
 * OME-Zarr 0.5 nests everything under an `ome` key; 0.4 and earlier put it at the
 * top level of `.zattrs`. Some writers emit the 0.4 shape inside a v3
 * `zarr.json`, so both are checked regardless of Zarr version.
 */
function omeAttributes(node: { attributes: JsonObject }): JsonObject[] {
  const bags: JsonObject[] = [];
  if (isObject(node.attributes.ome)) bags.push(node.attributes.ome);
  bags.push(node.attributes);
  return bags;
}

export interface MultiscaleInfo {
  /** Version declared by the metadata, if any. */
  version?: string;
  /** Axis names in order, when the metadata declares axes (OME-Zarr >= 0.3). */
  axes?: string[];
  /** Relative paths of the resolution levels, highest resolution first. */
  paths: string[];
  name?: string;
}

/**
 * Extract multiscale information, or null if this group is not a multiscale
 * image. Presence of `multiscales` is what makes a group an image root.
 */
export function readMultiscale(node: { attributes: JsonObject }): MultiscaleInfo | null {
  for (const bag of omeAttributes(node)) {
    const multiscales = bag.multiscales;
    if (!Array.isArray(multiscales) || multiscales.length === 0) continue;

    const first = multiscales[0];
    if (!isObject(first)) continue;

    const paths: string[] = [];
    if (Array.isArray(first.datasets)) {
      for (const entry of first.datasets) {
        if (isObject(entry) && typeof entry.path === 'string') paths.push(entry.path);
      }
    }

    let axes: string[] | undefined;
    if (Array.isArray(first.axes)) {
      const names = first.axes.map((axis) =>
        // OME-Zarr >= 0.4 uses objects; 0.3 used bare strings.
        typeof axis === 'string' ? axis : isObject(axis) && typeof axis.name === 'string' ? axis.name : '?',
      );
      if (names.length > 0) axes = names;
    }

    // In 0.5 the version sits beside `multiscales` in the `ome` bag; in
    // earlier versions it sits inside each multiscale entry.
    const version =
      typeof bag.version === 'string'
        ? bag.version
        : typeof first.version === 'string'
          ? first.version
          : undefined;

    return {
      version,
      axes,
      paths,
      name: typeof first.name === 'string' ? first.name : undefined,
    };
  }
  return null;
}

/**
 * True if the group advertises thumbnails via the Zarr `thumbnails` convention.
 *
 * Zarrcade reads these itself and picks the best-sized entry, so when they are
 * present the portal steps aside rather than generating a preview. Matches
 * upstream in consulting only `zarr.json`, i.e. OME-Zarr v5.
 */
export function hasThumbnailsConvention(node: {
  layout: OmeZarrLayout;
  attributes: JsonObject;
}): boolean {
  if (node.layout !== 'v5') return false;
  const thumbnails = node.attributes.thumbnails;
  return Array.isArray(thumbnails) && thumbnails.length > 0;
}

/** True if the group is an HCS plate root. */
export function isPlate(node: { attributes: JsonObject }): boolean {
  return omeAttributes(node).some((bag) => isObject(bag.plate));
}

/** True if the group is a `bioformats2raw.layout` container of image series. */
export function isBioformats2RawLayout(node: { attributes: JsonObject }): boolean {
  return omeAttributes(node).some((bag) => bag['bioformats2raw.layout'] !== undefined);
}

export interface ArrayInfo {
  shape?: number[];
  dtype?: string;
}

/** Read shape and dtype from an array's own metadata, for display purposes. */
export function readArrayInfo(raw: JsonObject): ArrayInfo {
  const shape = Array.isArray(raw.shape) && raw.shape.every((n) => typeof n === 'number')
    ? (raw.shape as number[])
    : undefined;

  // v3 calls it `data_type`, v2 `dtype` (with a byte-order prefix like `<u2`).
  const dtype =
    typeof raw.data_type === 'string'
      ? raw.data_type
      : typeof raw.dtype === 'string'
        ? raw.dtype
        : undefined;

  return { shape, dtype };
}
