/**
 * Neuroglancer integration.
 *
 * Neuroglancer itself is unmodified. It is bundled at `<base>neuroglancer/`
 * and driven entirely through its own `#!{...}` state fragment, which is the
 * upstream-supported way to open a viewer on a given set of sources.
 *
 * The only thing that makes local data work is that the sources are
 * same-origin `_local/...` URLs served by our worker: Neuroglancer's `zarr://`
 * data source sits on top of its HTTP key-value store, which needs nothing
 * more than GET, HEAD, byte ranges and honest 404s.
 */
import type { DiscoveredImage } from '../discovery/types';
import { siteUrl } from '../vfs/client';

/** Neuroglancer layer names must be unique; images can share a folder name. */
function uniqueNames(images: DiscoveredImage[]): string[] {
  const used = new Map<string, number>();
  return images.map((image) => {
    const base = image.name || 'image';
    const seen = used.get(base) ?? 0;
    used.set(base, seen + 1);
    return seen === 0 ? base : `${base} (${seen + 1})`;
  });
}

/** Orthogonal slice panels plus a 3-D view: right for volumetric data. */
const VOLUMETRIC_LAYOUT = '4panel-alt';
/** A single XY panel: right for data with no depth to slice through. */
const PLANAR_LAYOUT = 'xy';

/**
 * Whether an image has real depth, and so wants orthogonal panels.
 *
 * A 2-D image shown in the 4-panel layout wastes two panels on degenerate
 * single-voxel strips, so this decides which layout the viewer opens in.
 */
export function isVolumetric(image: DiscoveredImage): boolean {
  const { axes, shape } = image;

  // OME-Zarr before 0.4 carries no axes metadata and was always 5-D (tczyx).
  // Assume depth rather than risk flattening a volume to a single plane.
  if (!axes) return true;

  const z = axes.findIndex((axis) => axis.toLowerCase() === 'z');
  if (z === -1) return false;

  // A z axis of length 1 is a 2-D image that merely declares the dimension —
  // common in converted slide scans. Treat it as planar.
  if (shape && shape.length === axes.length) return shape[z] > 1;

  return true;
}

/**
 * Pick one layout for the whole viewer.
 *
 * Neuroglancer's layout is a property of the viewer, not of a layer, so a
 * mixed set has to compromise: if anything has depth, keep the orthogonal
 * panels, since that layout still shows planar layers correctly.
 */
export function chooseLayout(images: DiscoveredImage[]): string {
  if (images.length === 0) return VOLUMETRIC_LAYOUT;
  return images.some(isVolumetric) ? VOLUMETRIC_LAYOUT : PLANAR_LAYOUT;
}

export interface NeuroglancerState {
  layers: Array<{ type: string; name: string; source: string }>;
  selectedLayer?: { visible: boolean; layer: string };
  layout: string;
}

/**
 * Build viewer state with one layer per image.
 *
 * `type: "auto"` lets Neuroglancer decide from the OME-Zarr metadata whether an
 * image is an image or a segmentation, so label images come up correctly
 * without the portal having to interpret the metadata itself.
 */
export function buildNeuroglancerState(images: DiscoveredImage[]): NeuroglancerState {
  const names = uniqueNames(images);
  const layers = images.map((image, index) => ({
    type: 'auto',
    name: names[index],
    source: `zarr://${image.virtualUrl}`,
  }));

  return {
    layers,
    // The first layer is selected but its side panel stays closed: opening it
    // would cover a third of the window with shader controls before the user
    // has seen the image. Selecting it anyway means the panel shows that layer
    // when the user does open it.
    ...(layers.length > 0 ? { selectedLayer: { visible: false, layer: layers[0].name } } : {}),
    layout: chooseLayout(images),
  };
}

/**
 * URL of the bundled viewer, opened on the given images.
 *
 * `index.html` is named explicitly rather than relying on the host to serve a
 * directory index — true of GitHub Pages, but not of Vite's dev server.
 */
export function neuroglancerUrl(images: DiscoveredImage[]): string {
  const state = buildNeuroglancerState(images);
  return `${siteUrl('neuroglancer/index.html')}#!${encodeURIComponent(JSON.stringify(state))}`;
}

/**
 * A Zarrcade viewer template pointing at the bundled Neuroglancer.
 *
 * Zarrcade substitutes `{URL}` and `{NAME}` by plain string replacement, so
 * the fragment is left as raw JSON rather than percent-encoded — the same form
 * Zarrcade's stock templates use, and one Neuroglancer accepts.
 *
 * A template is a single string shared by every row, and Zarrcade exposes only
 * the path and name to it, so the layout cannot vary per image here. It is
 * chosen for the gallery as a whole, exactly as it is for a multi-layer view.
 */
export function neuroglancerUrlTemplate(images: DiscoveredImage[]): string {
  const state =
    '{"layers":[{"name":"{NAME}","source":"zarr://{URL}","type":"auto"}],' +
    `"selectedLayer":{"visible":true,"layer":"{NAME}"},"layout":"${chooseLayout(images)}"}`;
  return `${siteUrl('neuroglancer/index.html')}#!${state}`;
}
