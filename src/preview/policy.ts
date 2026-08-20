/**
 * When a preview is worth generating, and how big it may be.
 *
 * Previews are rendered on demand from the *lowest-resolution* level of a
 * multiscale image — the level that already exists precisely so that a
 * whole-image view is cheap. Nothing is precomputed and nothing is written to
 * disk.
 *
 * That level has to be read and decompressed, so eligibility is decided from
 * array metadata alone, before any data is touched. Both the catalog builder
 * and the renderer consult this, so an image can never be advertised as
 * previewable and then refused.
 */

/**
 * Upper bound on the data read to build one preview.
 *
 * Measured on what is actually read, not on the level as a whole: only the
 * first timepoint is fetched, so a long time series is judged by the size of
 * one timepoint rather than the sum of all of them.
 */
export const MAX_PREVIEW_BYTES = 200 * 1024 * 1024;

/**
 * Upper bound on either spatial extent. Byte count already bounds the read;
 * this additionally rules out degenerate shapes like 1 × 1,000,000 that would
 * project to a canvas no browser will allocate.
 */
export const MAX_PREVIEW_EXTENT = 4096;

/** Long edge of the emitted PNG. Zarrcade renders cards at roughly 300 px. */
export const PREVIEW_OUTPUT_EDGE = 512;

/** Which dimension plays which role in an array's shape. */
export interface AxisRoles {
  y: number;
  x: number;
  /** Time: only the first index is read. */
  t?: number;
  /** Channel: each one is projected and shown separately. */
  c?: number;
}

/**
 * Work out the role of each dimension.
 *
 * OME-Zarr declares axis names from 0.3 onwards, and they are used verbatim
 * when present. Older images declare nothing, but the pre-0.4 spec fixed the
 * layout at 5-D `tczyx`, so a rank-5 array with no axes is read that way; any
 * other rank falls back to "the last two dimensions are y and x", which is
 * true of every layout in practice.
 */
export function axisRoles(axes: string[] | undefined, rank: number): AxisRoles {
  if (axes && axes.length === rank) {
    const find = (name: string) => {
      const index = axes.findIndex((axis) => axis.toLowerCase() === name);
      return index === -1 ? undefined : index;
    };
    const y = find('y');
    const x = find('x');
    if (y !== undefined && x !== undefined) {
      return { y, x, t: find('t'), c: find('c') };
    }
  }

  if (!axes && rank === 5) {
    return { t: 0, c: 1, y: 3, x: 4 };
  }

  return { y: rank - 2, x: rank - 1 };
}

/**
 * Bytes per element for a dtype, in either Zarr spelling.
 *
 * v3 spells them out (`uint16`); v2 uses a NumPy descriptor with a byte-order
 * prefix and a width in bytes (`<u2`). An unrecognised dtype is assumed wide,
 * so an unknown format is gated conservatively rather than optimistically.
 */
export function bytesPerElement(dtype: string | undefined): number {
  if (!dtype) return 8;

  const named: Record<string, number> = {
    bool: 1,
    int8: 1,
    uint8: 1,
    int16: 2,
    uint16: 2,
    float16: 2,
    int32: 4,
    uint32: 4,
    float32: 4,
    int64: 8,
    uint64: 8,
    float64: 8,
    complex64: 8,
    complex128: 16,
  };
  const lower = dtype.toLowerCase();
  if (lower in named) return named[lower];

  // NumPy descriptor: optional byte order, a kind letter, then the width.
  const descriptor = /^[<>|=]?[biufc](\d+)$/.exec(lower);
  if (descriptor) return Number(descriptor[1]);

  return 8;
}

/**
 * How many bytes rendering a preview will read.
 *
 * The time dimension is excluded because only its first index is fetched.
 */
export function previewInputBytes(
  shape: number[],
  roles: AxisRoles,
  dtype: string | undefined,
): number {
  let elements = 1;
  for (let axis = 0; axis < shape.length; axis += 1) {
    if (axis === roles.t) continue;
    elements *= shape[axis];
  }
  return elements * bytesPerElement(dtype);
}

/** Decide whether the lowest-resolution level is small enough to project. */
export function isPreviewable(
  shape: number[],
  roles: AxisRoles,
  dtype: string | undefined,
): boolean {
  if (shape.length < 2) return false;

  const height = shape[roles.y];
  const width = shape[roles.x];
  if (!(height > 0) || !(width > 0)) return false;
  if (height > MAX_PREVIEW_EXTENT || width > MAX_PREVIEW_EXTENT) return false;

  if (shape.some((extent) => !(extent > 0))) return false;

  const bytes = previewInputBytes(shape, roles, dtype);
  return bytes > 0 && bytes <= MAX_PREVIEW_BYTES;
}
