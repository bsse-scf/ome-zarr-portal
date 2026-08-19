/**
 * On-demand preview rendering.
 *
 * Produces a PNG by maximum-intensity-projecting the *coarsest* level of a
 * dataset's multiscale pyramid onto its two spatial axes. That level exists
 * precisely so a whole-image view is cheap, so nothing has to be precomputed,
 * cached on disk, or generated ahead of time — the image is built when the
 * browser asks for it and thrown away after.
 *
 * Runs in a dedicated worker rather than the service worker, deliberately. A
 * service worker cannot use dynamic `import()`, so zarrita's WASM codecs would
 * have to be bundled into it eagerly — measured at 1.4 MB, which every visitor
 * would download and parse even if they never opened a gallery, and which took
 * service-worker cold start from ~8 ms to ~30 ms. Since that worker is on the
 * critical path for every byte Neuroglancer reads, the optional machinery
 * belongs elsewhere. A dedicated worker can import lazily, so the codecs cost
 * nothing until a preview is actually rendered.
 *
 * (Per-request throughput on warm `_local/` requests was unaffected either
 * way — about 1.2 ms per request in both builds.)
 */
import * as zarr from 'zarrita';

import { readMultiscale, readZarrNode } from '../discovery/zarr-metadata';
import {
  isPreviewable,
  PREVIEW_OUTPUT_EDGE,
  spatialAxes,
} from './policy';
import { DirectoryHandleStore } from './store';


/** Dtypes that cannot be projected to an intensity image. */
function isNumericDtype(dtype: string): boolean {
  return !/string|object|^\|[SUV]/i.test(dtype);
}

export class PreviewUnavailableError extends Error {}

/** Walk to a directory, or throw if any segment is missing. */
async function descend(
  root: FileSystemDirectoryHandle,
  relativePath: string,
): Promise<FileSystemDirectoryHandle> {
  let directory = root;
  for (const segment of relativePath.split('/').filter(Boolean)) {
    directory = await directory.getDirectoryHandle(segment);
  }
  return directory;
}

interface Projection {
  plane: Float64Array;
  height: number;
  width: number;
}

/**
 * Maximum-intensity projection onto the two spatial axes.
 *
 * Every other axis — time, channel, depth — is collapsed by taking the
 * maximum, which is one uniform rule that gives a recognisable image for
 * volumes, multi-channel stacks and time series alike.
 *
 * Indexing goes through the strides zarrita reports rather than assuming C
 * order with `y`,`x` last, so an unusual axis order still projects correctly.
 */
function project(
  data: ArrayLike<number | bigint | boolean>,
  shape: number[],
  stride: number[],
  yx: [number, number],
): Projection {
  const [yAxis, xAxis] = yx;
  const height = shape[yAxis];
  const width = shape[xAxis];

  const plane = new Float64Array(height * width).fill(Number.NEGATIVE_INFINITY);
  const rank = shape.length;
  const index = new Array<number>(rank).fill(0);
  const total = shape.reduce((product, extent) => product * extent, 1);

  for (let n = 0; n < total; n += 1) {
    let offset = 0;
    for (let axis = 0; axis < rank; axis += 1) offset += index[axis] * stride[axis];

    const raw = data[offset];
    const value = typeof raw === 'bigint' ? Number(raw) : Number(raw);
    if (Number.isFinite(value)) {
      const pixel = index[yAxis] * width + index[xAxis];
      if (value > plane[pixel]) plane[pixel] = value;
    }

    // Odometer increment over the remaining axes.
    for (let axis = rank - 1; axis >= 0; axis -= 1) {
      if (++index[axis] < shape[axis]) break;
      index[axis] = 0;
    }
  }

  return { plane, height, width };
}

/**
 * Pick a display range by clipping the extreme tails.
 *
 * A plain min/max stretch is at the mercy of a single hot pixel, which is
 * common in microscopy and washes the whole preview out. A histogram-based
 * 1st–99th percentile range costs one extra pass and is far more robust.
 */
function displayRange(plane: Float64Array): [number, number] {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  let populated = 0;

  for (const value of plane) {
    if (!Number.isFinite(value)) continue;
    populated += 1;
    if (value < min) min = value;
    if (value > max) max = value;
  }

  if (populated === 0 || !(max > min)) return [0, 0];

  const BINS = 1024;
  const histogram = new Uint32Array(BINS);
  const scale = BINS / (max - min);
  for (const value of plane) {
    if (!Number.isFinite(value)) continue;
    const bin = Math.min(BINS - 1, Math.floor((value - min) * scale));
    histogram[bin] += 1;
  }

  const lowTarget = populated * 0.01;
  const highTarget = populated * 0.99;
  let cumulative = 0;
  let lowBin = 0;
  let highBin = BINS - 1;
  for (let bin = 0; bin < BINS; bin += 1) {
    const before = cumulative;
    cumulative += histogram[bin];
    if (before < lowTarget && cumulative >= lowTarget) lowBin = bin;
    if (before < highTarget && cumulative >= highTarget) {
      highBin = bin;
      break;
    }
  }

  const low = min + lowBin / scale;
  const high = min + (highBin + 1) / scale;
  return high > low ? [low, high] : [min, max];
}

function toImageData({ plane, height, width }: Projection): ImageData {
  const [low, high] = displayRange(plane);
  const span = high - low;
  const pixels = new Uint8ClampedArray(width * height * 4);

  for (let i = 0; i < plane.length; i += 1) {
    const value = plane[i];
    let level = 0;
    if (Number.isFinite(value)) {
      level = span > 0 ? ((value - low) / span) * 255 : 128;
    }
    const clamped = level < 0 ? 0 : level > 255 ? 255 : level;
    const offset = i * 4;
    pixels[offset] = clamped;
    pixels[offset + 1] = clamped;
    pixels[offset + 2] = clamped;
    pixels[offset + 3] = 255;
  }

  return new ImageData(pixels, width, height);
}

/** Encode to PNG, scaling down when the projection is larger than needed. */
async function encodePng(image: ImageData): Promise<Blob> {
  const longEdge = Math.max(image.width, image.height);

  if (longEdge <= PREVIEW_OUTPUT_EDGE) {
    const canvas = new OffscreenCanvas(image.width, image.height);
    const context = canvas.getContext('2d');
    if (!context) throw new PreviewUnavailableError('No 2D context available');
    context.putImageData(image, 0, 0);
    return canvas.convertToBlob({ type: 'image/png' });
  }

  const ratio = PREVIEW_OUTPUT_EDGE / longEdge;
  const width = Math.max(1, Math.round(image.width * ratio));
  const height = Math.max(1, Math.round(image.height * ratio));

  const bitmap = await createImageBitmap(image);
  try {
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d');
    if (!context) throw new PreviewUnavailableError('No 2D context available');
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap, 0, 0, width, height);
    return canvas.convertToBlob({ type: 'image/png' });
  } finally {
    bitmap.close();
  }
}

/**
 * Render a preview for the dataset at `relativePath` inside a mount.
 *
 * Throws {@link PreviewUnavailableError} when the dataset has no usable
 * pyramid or its coarsest level is too large; callers turn that into a 404 so
 * the gallery falls back to its placeholder icon.
 */
export async function renderPreview(
  mountRoot: FileSystemDirectoryHandle,
  relativePath: string,
): Promise<Blob> {
  let datasetDirectory: FileSystemDirectoryHandle;
  try {
    datasetDirectory = await descend(mountRoot, relativePath);
  } catch {
    throw new PreviewUnavailableError('Dataset folder not found');
  }

  const node = await readZarrNode(datasetDirectory);
  if (node.kind !== 'group') throw new PreviewUnavailableError('Not a Zarr group');

  const multiscale = readMultiscale(node);
  if (!multiscale || multiscale.paths.length === 0) {
    throw new PreviewUnavailableError('No multiscale metadata');
  }

  // The last entry is the coarsest level: smallest to read, and already a
  // whole-image overview.
  const levelPath = multiscale.paths[multiscale.paths.length - 1];

  const store = new DirectoryHandleStore(datasetDirectory);
  const array = await zarr.open(zarr.root(store as never).resolve(`/${levelPath}`), {
    kind: 'array',
  });

  if (!isNumericDtype(String(array.dtype))) {
    throw new PreviewUnavailableError(`Cannot preview dtype ${String(array.dtype)}`);
  }

  const shape = [...array.shape];
  const yx = spatialAxes(multiscale.axes, shape.length);
  if (!isPreviewable(shape, yx)) {
    throw new PreviewUnavailableError('Coarsest level is too large to project');
  }

  const region = await zarr.get(array as never);
  const projection = project(
    region.data as ArrayLike<number | bigint | boolean>,
    [...region.shape],
    [...region.stride],
    yx,
  );

  return encodePng(toImageData(projection));
}
