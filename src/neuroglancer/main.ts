/**
 * Same-origin Neuroglancer client.
 *
 * This is stock Neuroglancer: `setupDefaultViewer` installs the upstream
 * `UrlHashBinding`, so the viewer state is driven entirely by the `#!{...}`
 * fragment. The portal builds that fragment (see
 * `src/integrations/neuroglancer.ts`) with `zarr://` sources pointing at the
 * service worker's `/_local/...` namespace.
 *
 * Because this page is served from the portal's own origin, those virtual
 * URLs are same-origin and need no CORS handling and no upstream patch.
 */
import 'neuroglancer/unstable/ui/default_viewer.css';
import { setupDefaultViewer } from 'neuroglancer/unstable/ui/default_viewer_setup.js';

function start(): void {
  setupDefaultViewer({
    target: document.getElementById('neuroglancer-container') ?? undefined,
  });
}

// Module scripts are deferred, so the container normally exists by now; the
// readyState check covers the case where this module is loaded later.
if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', start, { once: true });
} else {
  start();
}
