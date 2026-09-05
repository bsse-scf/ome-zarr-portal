/**
 * Same-origin Neuroglancer client.
 *
 * This is stock Neuroglancer: `setupDefaultViewer` installs the upstream
 * `UrlHashBinding`, so the viewer state comes from the `#!{...}` fragment. The
 * portal builds that fragment (see `src/integrations/neuroglancer.ts`) with
 * `zarr://` sources pointing at the service worker's `/_local/...` namespace.
 * Two things are added here rather than through the fragment, which cannot
 * express either: `keepTimeScrollable`, and a short navigation help card.
 *
 * Because this page is served from the portal's own origin, those virtual
 * URLs are same-origin and need no CORS handling and no upstream patch.
 */
// Upstream's entry point. This is what registers the layer types, the data
// sources (`zarr://`) and the key-value stores (`http://`) — `setupDefaultViewer`
// builds the UI but registers none of them. Without this import every source
// fails with "Unsupported scheme: zarr:".
import 'neuroglancer';
import 'neuroglancer/unstable/ui/default_viewer.css';
import { setupDefaultViewer } from 'neuroglancer/unstable/ui/default_viewer_setup.js';
import type { Viewer } from 'neuroglancer/unstable/viewer.js';

import { addNavigationHelp } from './navigation-help';

/**
 * The dimensions Neuroglancer should render, in screen order: the first is the
 * horizontal axis of a cross-section panel, the second the vertical one.
 * Neuroglancer already orders spatial data this way itself — a plain `c,y,x`
 * image comes out as x, y — so this is its own convention, not a new one.
 */
const SPATIAL_DIMENSIONS = ['x', 'y', 'z'];

/** OME-Zarr names its time axis `t`, and Neuroglancer carries that name through. */
const TIME_DIMENSION = 't';

/**
 * Keep time out of the display dimensions.
 *
 * Neuroglancer displays at most three dimensions and, absent anything better,
 * takes the first three of the global coordinate space. For a 2-D timelapse
 * (`t,c,y,x`) those are t, y and x: time becomes a rendered axis, so the panel
 * slices through it instead of showing the image, and the y/x order transposes
 * what is left. Displaying only the spatial axes puts time where it belongs —
 * a coordinate in the position bar, scrolled a timepoint at a time.
 *
 * Volumetric series (`t,c,z,y,x`) already come out as x, y, z; those are left
 * untouched, and so is any choice the user makes in the viewer afterwards.
 *
 * This cannot be done through the `#!{...}` fragment: `displayDimensions` is
 * restored before any layer has loaded, when the global coordinate space is
 * still empty and the dimension names it refers to do not exist yet, so
 * Neuroglancer discards it and falls back to that default. Naming the
 * dimensions in the fragment as well would make it stick, but their scales and
 * units would then come from the fragment rather than from the data.
 */
function keepTimeScrollable(viewer: Viewer): void {
  const { coordinateSpace, displayDimensions } = viewer;

  const update = (): void => {
    const { names } = coordinateSpace.value;
    // Act only on Neuroglancer's own default, so nothing chosen in the viewer
    // — or set by an earlier run of this — is ever overridden.
    if (!displayDimensions.default) return;
    const displayed = displayDimensions.value.displayDimensionIndices;
    if (!displayed.some((index) => names[index] === TIME_DIMENSION)) return;

    const spatial = SPATIAL_DIMENSIONS.map((name) => names.indexOf(name)).filter(
      (index) => index !== -1,
    );
    if (spatial.length === 0) return;

    const indices = new Int32Array(3).fill(-1);
    indices.set(spatial);
    displayDimensions.setDimensionIndices(spatial.length, indices);
  };

  // The global coordinate space is empty until a layer's data source resolves,
  // so this listens for changes rather than running once at startup.
  coordinateSpace.changed.add(update);
  update();
}

function start(): void {
  const viewer = setupDefaultViewer({
    target: document.getElementById('neuroglancer-container') ?? undefined,
    // Hide the layer bar — the row of layer-name tabs above the panels.
    // The portal decides what is open before the viewer starts, and every
    // layer is already named by its path in the gallery, so the bar only
    // repeats that list and takes vertical space from the image. Layers stay
    // reachable through the layer-list button in the top bar.
    showLayerPanel: false,
  });
  keepTimeScrollable(viewer);
  addNavigationHelp(viewer);
}

// Module scripts are deferred, so the container normally exists by now; the
// readyState check covers the case where this module is loaded later.
if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', start, { once: true });
} else {
  start();
}
