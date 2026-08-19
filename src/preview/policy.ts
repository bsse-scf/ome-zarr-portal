/**
 * When a preview is worth generating, and how big it may be.
 *
 * Previews are rendered on demand from the *coarsest* level of a dataset's
 * multiscale pyramid — the level that already exists precisely so that a
 * whole-image view is cheap. Nothing is precomputed and nothing is written to
 * disk.
 *
 * The whole level has to be read and decompressed to project it, so eligibility
 * is decided from array metadata alone, before any data is touched. A
 * well-formed pyramid bottoms out well inside these bounds; a dataset whose
 * coarsest level is still enormous is exactly the one to skip.
 *
 * Both the catalog builder and the service worker consult this, so a dataset
 * can never be advertised as previewable and then refused.
 */

/** Upper bound on the elements read to build one preview (1024 × 1024). */
export const MAX_PREVIEW_ELEMENTS = 1 << 20;

/**
 * Upper bound on either spatial extent. Element count already bounds memory;
 * this additionally rules out degenerate shapes like 1 × 1,000,000 that would
 * project to a canvas no browser will allocate.
 */
export const MAX_PREVIEW_EXTENT = 4096;

/** Long edge of the emitted PNG. Zarrcade renders cards at roughly 300 px. */
export const PREVIEW_OUTPUT_EDGE = 512;

export interface PreviewCandidate {
  /** Path of the coarsest level, relative to the dataset root. */
  levelPath: string;
  /** Shape of that level. */
  shape: number[];
}

/**
 * Decide whether the coarsest level is small enough to project.
 *
 * `yx` are the indices of the two spatial axes within `shape`; when the axes
 * are unknown the caller passes the last two dimensions.
 */
export function isPreviewable(shape: number[], yx: [number, number]): boolean {
  if (shape.length < 2) return false;

  const height = shape[yx[0]];
  const width = shape[yx[1]];
  if (!(height > 0) || !(width > 0)) return false;
  if (height > MAX_PREVIEW_EXTENT || width > MAX_PREVIEW_EXTENT) return false;

  const elements = shape.reduce((total, extent) => total * extent, 1);
  return elements > 0 && elements <= MAX_PREVIEW_ELEMENTS;
}

/**
 * Locate the y and x axes in an axis-name list.
 *
 * OME-NGFF conventionally orders axes `tczyx`, but the order is declared, not
 * assumed. Falls back to the last two dimensions, which is the layout every
 * pre-0.4 dataset used.
 */
export function spatialAxes(axes: string[] | undefined, rank: number): [number, number] {
  if (axes && axes.length === rank) {
    const y = axes.findIndex((axis) => axis.toLowerCase() === 'y');
    const x = axes.findIndex((axis) => axis.toLowerCase() === 'x');
    if (y !== -1 && x !== -1) return [y, x];
  }
  return [rank - 2, rank - 1];
}
