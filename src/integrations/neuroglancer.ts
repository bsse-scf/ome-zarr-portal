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
import type { DiscoveredDataset } from '../discovery/types';
import { siteUrl } from '../vfs/client';

/** Neuroglancer layer names must be unique; datasets can share a folder name. */
function uniqueNames(datasets: DiscoveredDataset[]): string[] {
  const used = new Map<string, number>();
  return datasets.map((dataset) => {
    const base = dataset.name || 'image';
    const seen = used.get(base) ?? 0;
    used.set(base, seen + 1);
    return seen === 0 ? base : `${base} (${seen + 1})`;
  });
}

export interface NeuroglancerState {
  layers: Array<{ type: string; name: string; source: string }>;
  selectedLayer?: { visible: boolean; layer: string };
  layout: string;
}

/**
 * Build viewer state with one layer per dataset.
 *
 * `type: "auto"` lets Neuroglancer decide from the OME-NGFF metadata whether a
 * dataset is an image or a segmentation, so label datasets come up correctly
 * without the portal having to interpret the metadata itself.
 */
export function buildNeuroglancerState(datasets: DiscoveredDataset[]): NeuroglancerState {
  const names = uniqueNames(datasets);
  const layers = datasets.map((dataset, index) => ({
    type: 'auto',
    name: names[index],
    source: `zarr://${dataset.virtualUrl}`,
  }));

  return {
    layers,
    ...(layers.length > 0 ? { selectedLayer: { visible: true, layer: layers[0].name } } : {}),
    layout: '4panel-alt',
  };
}

/**
 * URL of the bundled viewer, opened on the given datasets.
 *
 * `index.html` is named explicitly rather than relying on the host to serve a
 * directory index — true of GitHub Pages, but not of Vite's dev server.
 */
export function neuroglancerUrl(datasets: DiscoveredDataset[]): string {
  const state = buildNeuroglancerState(datasets);
  return `${siteUrl('neuroglancer/index.html')}#!${encodeURIComponent(JSON.stringify(state))}`;
}

/**
 * A Zarrcade viewer template pointing at the bundled Neuroglancer.
 *
 * Zarrcade substitutes `{URL}` and `{NAME}` by plain string replacement, so
 * the fragment is left as raw JSON rather than percent-encoded — the same form
 * Zarrcade's stock templates use, and one Neuroglancer accepts.
 */
export function neuroglancerUrlTemplate(): string {
  const state =
    '{"layers":[{"name":"{NAME}","source":"zarr://{URL}","type":"auto"}],' +
    '"selectedLayer":{"visible":true,"layer":"{NAME}"},"layout":"4panel-alt"}';
  return `${siteUrl('neuroglancer/index.html')}#!${state}`;
}
