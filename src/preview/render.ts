/**
 * On-demand preview rendering.
 *
 * Produces a PNG by maximum-intensity-projecting the *coarsest* level of a
 * dataset's multiscale pyramid onto its two spatial axes. That level exists
 * precisely so a whole-image view is cheap, so nothing has to be precomputed,
 * cached on disk, or generated ahead of time — the image is built when the
 * browser asks for it and thrown away after.
 *
 * Two axes are treated as more than something to collapse. Only the first
 * timepoint is read, because a time series is a sequence of images rather than
 * one image, and projecting across it would both smear every frame together
 * and multiply the read by the length of the series. Channels are projected
 * separately and then overlaid in colour, the usual composite view: they are
 * different stains of the same field, and a maximum across them would show
 * only the brightest one.
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
  axisRoles,
  isPreviewable,
  PREVIEW_OUTPUT_EDGE,
  type AxisRoles,
} from './policy';
import { DirectoryHandleStore } from './store';


/**
 * Colour per channel, in the order channels appear.
 *
 * Green and magenta lead because a two-channel overlay is the common case and
 * that pair stays legible to colour-blind viewers, unlike the red/green it
 * replaces. The list also sets the cap: channels past its end are dropped,
 * since an additive blend of more than a handful of colours is mud.
 */
const CHANNEL_COLORS: ReadonlyArray<readonly [number, number, number]> = [
  [0, 255, 0],
  [255, 0, 255],
  [0, 255, 255],
  [255, 255, 0],
  [255, 128, 0],
  [0, 128, 255],
  [255, 0, 0],
  [128, 255, 0],
];

/** A lone channel is shown as grey, not tinted; there is nothing to tell apart. */
const MONOCHROME: readonly [number, number, number] = [255, 255, 255];

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
 * Read the data a preview is built from.
 *
 * The whole level, except that a time axis is pinned to its first index —
 * indexing with a plain integer drops that axis, so what comes back is one
 * timepoint and the roles are renumbered to match.
 */
async function readPreviewRegion(
  array: zarr.Array<zarr.DataType, never>,
  roles: AxisRoles,
): Promise<{ region: zarr.Chunk<zarr.DataType>; roles: AxisRoles }> {
  if (roles.t === undefined) {
    return { region: await zarr.get(array as never), roles };
  }

  const time = roles.t;
  const selection = new Array<number | null>(array.shape.length).fill(null);
  selection[time] = 0;
  const region = (await zarr.get(
    array as never,
    selection as never,
  )) as zarr.Chunk<zarr.DataType>;

  const shift = (axis: number) => (axis > time ? axis - 1 : axis);
  return {
    region,
    roles: {
      y: shift(roles.y),
      x: shift(roles.x),
      c: roles.c === undefined ? undefined : shift(roles.c),
    },
  };
}

/**
 * Maximum-intensity projection onto the two spatial axes, one plane per
 * channel.
 *
 * Every other axis — depth above all — is collapsed by taking the maximum,
 * which is one uniform rule that gives a recognisable image for volumes and
 * flat images alike. Channels are kept apart: each gets its own plane, so they
 * can be tinted and overlaid rather than merged into whichever is brightest.
 *
 * Indexing goes through the strides zarrita reports rather than assuming C
 * order with `y`,`x` last, so an unusual axis order still projects correctly.
 */
function project(
  data: ArrayLike<number | bigint | boolean>,
  shape: number[],
  stride: number[],
  roles: AxisRoles,
): Projection[] {
  const { y: yAxis, x: xAxis, c: cAxis } = roles;
  const height = shape[yAxis];
  const width = shape[xAxis];

  const channels =
    cAxis === undefined ? 1 : Math.min(shape[cAxis], CHANNEL_COLORS.length);
  const planes = Array.from({ length: channels }, () =>
    new Float64Array(height * width).fill(Number.NEGATIVE_INFINITY),
  );

  const rank = shape.length;
  const index = new Array<number>(rank).fill(0);
  const total = shape.reduce((product, extent) => product * extent, 1);

  for (let n = 0; n < total; n += 1) {
    // Channels past the cap are read but not drawn.
    const channel = cAxis === undefined ? 0 : index[cAxis];
    if (channel < channels) {
      let offset = 0;
      for (let axis = 0; axis < rank; axis += 1) offset += index[axis] * stride[axis];

      const raw = data[offset];
      const value = typeof raw === 'bigint' ? Number(raw) : Number(raw);
      if (Number.isFinite(value)) {
        const plane = planes[channel];
        const pixel = index[yAxis] * width + index[xAxis];
        if (value > plane[pixel]) plane[pixel] = value;
      }
    }

    // Odometer increment over the remaining axes.
    for (let axis = rank - 1; axis >= 0; axis -= 1) {
      if (++index[axis] < shape[axis]) break;
      index[axis] = 0;
    }
  }

  return planes.map((plane) => ({ plane, height, width }));
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

/**
 * Blend the channel planes into one image.
 *
 * Each channel is stretched on its own range — intensities routinely differ by
 * orders of magnitude between stains, and a shared range would leave the dim
 * ones black — then tinted and added to the others, which is the composite
 * every microscopy viewer shows. `Uint8ClampedArray` saturates on overflow, so
 * co-located signal goes white rather than wrapping around.
 */
function toImageData(planes: Projection[]): ImageData {
  const { height, width } = planes[0];
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let alpha = 3; alpha < pixels.length; alpha += 4) pixels[alpha] = 255;

  planes.forEach((channel, index) => {
    const [red, green, blue] =
      planes.length === 1 ? MONOCHROME : CHANNEL_COLORS[index];
    const [low, high] = displayRange(channel.plane);
    const span = high - low;

    for (let pixel = 0; pixel < channel.plane.length; pixel += 1) {
      const value = channel.plane[pixel];
      let level = 0;
      if (Number.isFinite(value)) level = span > 0 ? (value - low) / span : 0.5;
      const scaled = level < 0 ? 0 : level > 1 ? 1 : level;

      const offset = pixel * 4;
      pixels[offset] += scaled * red;
      pixels[offset + 1] += scaled * green;
      pixels[offset + 2] += scaled * blue;
    }
  });

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

  const dtype = String(array.dtype);
  if (!isNumericDtype(dtype)) {
    throw new PreviewUnavailableError(`Cannot preview dtype ${dtype}`);
  }

  const shape = [...array.shape];
  const roles = axisRoles(multiscale.axes, shape.length);
  if (!isPreviewable(shape, roles, dtype)) {
    throw new PreviewUnavailableError('Coarsest level is too large to project');
  }

  const { region, roles: regionRoles } = await readPreviewRegion(array, roles);
  const planes = project(
    region.data as ArrayLike<number | bigint | boolean>,
    [...region.shape],
    [...region.stride],
    regionRoles,
  );

  return encodePng(toImageData(planes));
}
