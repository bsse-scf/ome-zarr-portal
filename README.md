# OME-Zarr Portal

A browser-based portal for looking at **local** OME-Zarr data. Drop an image —
or a folder full of them — and open it in either [Neuroglancer][ng] (3-D
visualization) or a [Zarrcade][zc] gallery (browsing, search, metadata).

Nothing is uploaded. There is no backend. The image data never leaves the
machine it is already on: the page serves it to itself through a Service
Worker.

```
                    Landing page
                         │
              ┌──────────┴──────────┐
              │                     │
      Neuroglancer drop       Gallery drop
              │                     │
              └──────────┬──────────┘
                         │
                OME-Zarr discovery          src/discovery/
                         │
                filesystem mounts           src/mounts/
                         │
                  Service Worker            src/vfs/
                         │
                 virtual HTTP URLs
                  <base>_local/…
                         │
              ┌──────────┴──────────┐
              │                     │
        Neuroglancer             Zarrcade
      /neuroglancer/            /zarrcade/
```

## Quick start

```bash
npm install     # also vendors the prebuilt Zarrcade SPA into public/zarrcade/
npm run dev     # http://localhost:5173
npm test          # discovery, HTTP serving and integration contracts (Node)
npm run test:browser  # end-to-end in real Chrome against a production build
npm run build     # -> dist/
```

`test:browser` needs Chrome (`CHROME_PATH` overrides the default
`/usr/bin/google-chrome`).

Requires a Chromium-based browser (see [Limitations](#limitations)).

## How the virtual filesystem works

The problem: Neuroglancer and Zarrcade both consume OME-Zarr over HTTP. A
`FileSystemDirectoryHandle` from a drag-and-drop is not HTTP. Copying gigabytes
into OPFS to bridge the gap is not acceptable.

The solution is a Service Worker that answers HTTP requests by reading the
handle directly.

### Mounting

Dropping a folder yields a `FileSystemDirectoryHandle` via
`DataTransferItem.getAsFileSystemHandle()`. The handle is given a random id and
written to IndexedDB (`src/mounts/registry.ts`).

IndexedDB is the important part: `FileSystemHandle` is structured-cloneable, so
storing it there hands the *worker* — not the page — the ability to read files.
That matters because the browser can kill and restart a Service Worker at any
moment; a handle kept only in worker memory would not survive.

**No file contents are ever stored.** Only the handle, which is a reference.

### Serving

The worker (`src/vfs/sw.ts`) claims the whole site and intercepts two
namespaces:

```
GET|HEAD  <base>_local/<mount-id>/<relative-path>    bytes from disk
GET|HEAD  <base>_session/<session-id>/<name>         a generated document
```

For example:

```
/_local/abc123/sample.ome.zarr/zarr.json
/_local/abc123/sample.ome.zarr/0/zarr.json
/_local/abc123/sample.ome.zarr/0/c/0/0/0
```

The HTTP semantics live in `src/vfs/serve.ts`, separate from the worker's event
wiring so they can be tested outside a browser. Supported:

(A third namespace, `_preview/`, is described under
[Previews](#previews).)

| Feature | Behaviour |
| --- | --- |
| `GET`, `HEAD` | 200 with `Content-Length`; `HEAD` omits the body |
| Byte ranges | `206 Partial Content` with `Content-Range`; `416` when unsatisfiable |
| `Accept-Ranges: bytes` | always advertised |
| Missing file | `404` |
| Directory | `404` (`X-Local-Error: is-directory`) — Zarr never needs a listing |
| Other methods | `405` with `Allow: GET, HEAD` |
| Lost permission | `403` (`X-Local-Error: permission-lost`) |
| `..` or encoded `/` in a segment | `400`, rejected before touching the filesystem |

Multi-range requests are answered with the full body rather than a
`multipart/byteranges` response. RFC 9110 permits a server to ignore `Range`,
and neither viewer needs it.

The worker is **format-agnostic**: it knows nothing about Zarr. That is what
lets two independent tools share one namespace with no adaptation.

Reading a byte range slices the live `File`, so opening a 200 GB image costs
no disk space and no copy. Intermediate directory handles are cached per mount,
because a chunked array issues thousands of requests sharing a long path
prefix.

### Previews

Gallery cards show an image without any precomputation step. The rule:

1. **If the image ships thumbnails** (the [Zarr `thumbnails` convention][thumb]),
   use them. The portal leaves the catalog's thumbnail cell empty and Zarrcade
   reads the convention itself, picking the best-sized entry — upstream already
   does this well.
2. **Otherwise**, project the *lowest-resolution* level of the multiscale. That
   level exists precisely so a whole-image view is cheap, so the preview costs
   one small read rather than a rendering pipeline.
3. **Unless it is still too big.** Eligibility is decided at discovery time from
   array metadata alone — no data is read — so an oversized image simply gets
   no preview and falls back to the placeholder icon.

The bounds live in `src/preview/policy.ts`: at most 200 MB read, with neither
spatial extent above 4096. The budget is in bytes rather than elements because
the same shape costs eight times as much in `float64` as in `uint8`, and it is
measured on what is actually read rather than on the level as a whole — a
1,000-timepoint series is judged by one timepoint. A well-formed multiscale
bottoms out well inside that; an image whose smallest level is still enormous
is exactly the one to skip.

Not every axis is treated alike:

- **Time**: only the first timepoint is read. A time series is a sequence of
  images, not one image; projecting across it smears every frame together and
  multiplies the read by the length of the series.
- **Channel**: each channel is projected separately, then tinted and added to
  the others — the composite view every microscopy tool shows. A maximum across
  channels would show only the brightest, and side-by-side panels are
  unreadable at card size. Each channel is stretched on its own range, since
  intensities routinely differ by orders of magnitude between stains. The
  palette leads with green and magenta, which stay legible to colour-blind
  viewers; it holds eight colours and channels past it are dropped, an additive
  blend of more than a handful being mud. A single channel stays grey.
- **Depth and anything else**: collapsed by taking the maximum.

Axis roles come from the declared `axes` names; a rank-5 array that declares
none is read as `tczyx`, which the pre-0.4 spec fixed, and anything else falls
back to "the last two dimensions are `y` and `x`". Indexing follows the strides
the reader reports rather than assuming an axis order. Contrast is stretched to
the 1st–99th percentile via a histogram, because a single hot pixel would
otherwise wash out a min/max scaling.

Previews are served from a third namespace:

```
GET|HEAD  <base>_preview/<mount-id>/<image-path>   a generated PNG
```

`_local/` stays a faithful mirror of what is on disk; a preview is derived, so
it lives elsewhere.

**Where the work happens.** The service worker does *not* render previews. It
asks a portal page to, over `postMessage`, and that page hands the job to a
pool of two dedicated workers. The reason is that a service worker cannot use
dynamic `import()`, so [zarrita][zarrita]'s WASM codecs would have to be bundled
into it eagerly — 1.4 MB downloaded and parsed by every visitor whether or not
they ever open a gallery, taking worker cold start from ~8 ms to ~30 ms. That
worker is on the critical path for every byte Neuroglancer reads, so optional
machinery does not belong in it. (Warm per-request throughput was the same
either way, ~1.2 ms; only cold start differed.)

The cost of that split is one failure mode: if no portal page is open anywhere
— a gallery left in a tab of its own after the portal was closed — nothing
answers, and the request 404s. Zarrcade's image `onerror` then shows its
placeholder, which is the same graceful path taken by every other reason a
preview might be unavailable.

### The `_session/` namespace

Zarrcade is configured by URL: it fetches a JSON config, which names a CSV
catalog. The portal generates both in memory and serves them from
`_session/<id>/`, so Zarrcade can fetch them like any other file. These are
derived documents, never user data.

## Discovery

`src/discovery/` walks mounted directories and returns a normalized list:

```ts
interface DiscoveredImage {
  id: string;
  name: string;
  relativePath: string;
  virtualUrl: string;
  omeZarrVersion?: string;
  // plus context and best-effort metadata: mountId, mountName, layout,
  // axes, shape, dtype, levelCount
}
```

Detection is driven by metadata, not by filename: a `.ome.zarr` suffix is a
convention, not a guarantee, and plenty of valid images do not use it. Both
layouts in current use are handled:

* **OME-Zarr v4 and earlier** — `.zgroup`, `.zarray`, `.zattrs`, with
  `multiscales` at the top level of `.zattrs`.
* **OME-Zarr v5** — a single `zarr.json` whose `node_type` distinguishes group
  from array, with `multiscales` under `attributes.ome`.

Two rules keep the walk both correct and cheap:

1. **A group carrying `multiscales` *is* the image**, and the walk stops
   there. This is what prevents the resolution levels beneath it (`0/`, `1/`, …)
   from being reported as images of their own.
2. **A Zarr array is never descended into.** Its children are chunk files and
   chunk directories — potentially millions of entries.

Each directory is classified by probing three filenames, which never
enumerates entries. Enumeration happens only for directories that turn out not
to be Zarr arrays.

Other cases:

* **A dropped image root** is returned as a single image (`relativePath: ''`).
* **HCS plates** are not openable as one image, so the walk continues into them
  and lists each field of view, with a note saying so.
* **`bioformats2raw.layout` groups** are walked into, listing each image series.
* **A bare Zarr array** is reported as unsupported when dropped directly, and
  silently ignored when encountered deeper down.
* Depth, image count, directory count and entries-per-directory are all
  **bounded**, and hitting a bound produces a visible note rather than a hang.

## Upstream modifications

**No code changes to either project.** This was the goal, and both upstreams
turned out to have a supported extension point that fits. Zarrcade gains one
added stylesheet, which only hides — see below.

### Neuroglancer — unmodified

Bundled from the `neuroglancer` npm package (2.41.2) with Vite as a second page
in the multi-page build (`neuroglancer/index.html`, `src/neuroglancer/main.ts`).
The entry point is a handful of lines: import the package entry point and the
stock CSS, then call the stock `setupDefaultViewer()`.

Importing the package entry point (`import 'neuroglancer'`, i.e. upstream's
`main_module.js`) is **required and easy to miss**. `setupDefaultViewer()`
builds the UI but registers nothing; the entry point is what pulls in
`enabled_frontend_modules.js` for layers, data sources and key-value stores.
Without it every source fails with `Unsupported scheme: zarr:`, and the bundle
is roughly 900 kB instead of 1.5 MB. `tests/browser/run.mjs` guards against
this specific regression.

The package builds under Vite as-is — its sources already use Vite's `?raw`
asset imports and `new URL(…, import.meta.url)` module workers, and its WASM
decoders are emitted as ordinary assets.

Neuroglancer is driven through its own `#!{…}` state fragment, the
upstream-supported way to open a viewer on a given set of sources. The portal
builds one `zarr://` layer per discovered image with `type: "auto"`, which
lets Neuroglancer decide from the OME-Zarr metadata whether an image is an
image or a segmentation.

The **layout** is chosen from the data. Images with real depth open in the
four-panel orthogonal layout (`4panel-alt`); images with no z axis open as a
single `xy` panel, since orthogonal panels of a 2-D image are two degenerate
single-voxel strips. A z axis of length 1 counts as planar — common in
converted slide scans — and OME-Zarr older than 0.4, which declares no axes at
all, is assumed volumetric because it was always 5-D.

Neuroglancer's layout belongs to the viewer rather than to a layer, so a drop
containing both kinds keeps the orthogonal layout, which still displays planar
layers correctly. The same choice is baked into the Zarrcade viewer template:
Zarrcade exposes only a row's path and name to a template, so the layout is
picked for the gallery as a whole rather than per image.

Nothing needed patching because the virtual URLs are same-origin, ordinary
HTTP. Neuroglancer's `zarr://` source sits on its HTTP key-value store, which
needs exactly what the worker provides: `GET`, `HEAD`, byte ranges and honest
404s.

### Zarrcade — unmodified, configured

Zarrcade v3 (`@janelia/zarrcade`) is a static, config-driven React SPA. Its
prebuilt `dist/` is vendored into `public/zarrcade/` by
`scripts/vendor-zarrcade.mjs` and served at `<base>zarrcade/`. It is built with
a relative base, so it runs from a subpath unchanged.

Its documented extension point — `?config=<url>` → a JSON config → a CSV
catalog — is exactly the hook needed. Instead of the usual pre-generated static
catalog, the portal generates both documents from the discovered images at
drop time and serves them from `_session/` (`src/integrations/zarrcade.ts`).

The one substantive difference from a normal Zarrcade deployment is the
**viewer list**. Zarrcade ships with external viewers — the public Neuroglancer
demo, Avivator, the OME-Zarr validator — and none of them can reach a `_local/`
URL that exists only inside this browser. The generated config replaces them
with the Neuroglancer bundled alongside the portal. This is configuration, not
a patch.

The only file dropped when vendoring is Zarrcade's stock `config.json`, so that
a bare visit to `/zarrcade/` shows its own Welcome screen rather than a
misconfigured gallery.

The only file added is `zarrcade/local-data.css`, copied in beside the bundle
and linked from its `index.html`. Zarrcade is built for catalogs published on
the web, and a few of its controls exist purely to pass a data URL to something
else: **Copy data URL** on a card and in the detail view, **Copy link to
current view**, and **View collection in BioFile Finder**. Here those URLs
resolve only inside this browser, through the Service Worker, and only while
the folder is still mounted; BioFile Finder in particular is handed the catalog
URL and fetches it from `bff.allencell.org`, an origin the worker does not
control and where no server holds a copy. The stylesheet hides those four
controls and nothing else — no rule restyles anything, and the bundle is
untouched. **Download metadata as CSV** is left in place, since it builds the
file in the browser.

Linking the stylesheet from the vendored `index.html`, rather than injecting it
from the portal page, means it applies to the gallery opened in a tab of its
own as well as inside the portal's frame.

Consequences worth knowing:

* Zarrcade's own thumbnail support reads the [Zarr `thumbnails` convention][thumb]
  from `zarr.json` → `attributes.thumbnails`, i.e. OME-Zarr v5 only. The portal
  fills the gap for everything else by generating previews; see
  [Previews](#previews).
* Zarrcade derives the Neuroglancer layer name from the URL basename with only
  `.zarr` stripped, so a `sample.ome.zarr` opened from the gallery is labelled
  `sample.ome`. Opening the same image from the landing page gives `sample`.
* Anything that would take a URL out of this browser cannot work here, and is
  hidden rather than left to fail; a gallery of local data has nothing to link
  to.

## Deploying to GitHub Pages

`.github/workflows/deploy.yml` builds and publishes `dist/` on every push to
`main`. Enable Pages for the repository with **Source: GitHub Actions**.

The build uses a **relative base** (`base: './'`), so one build works at an
origin root *and* at a project subpath like
`https://<user>.github.io/<repo>/` — nothing needs to know the repository name.

A Service Worker can only claim a scope at or below its own path, so at a
subpath the namespace is `/<repo>/_local/…`, not `/_local/…`. Both sides derive
the base at runtime rather than baking it in: the worker from
`registration.scope`, the page from the same scope once registered. The worker
is registered relative to the landing page, which resolves correctly in both
deployments.

In development a small Vite middleware serves the worker at `/sw.js` with a
`Service-Worker-Allowed` header, so the registration code is identical in both
modes.

GitHub Pages serves over HTTPS, which the File System Access API and Service
Workers both require.

## Limitations

**Chromium only.** The portal needs `DataTransferItem.getAsFileSystemHandle()`,
which today means Chrome, Edge or another Chromium browser. Firefox and Safari
support the older `webkitGetAsEntry()`, but it yields `FileSystemEntry` objects
that cannot be structured-cloned into a Service Worker — which is the entire
basis of this design. The landing page detects this and says so.

**Secure context required.** Service Workers need `https://` or
`http://localhost`.

**Mounts do not survive a reload.** Handles persist in IndexedDB, but their
permission grant does not, and re-granting requires a user gesture. On startup
the portal checks each stored mount and forgets any it can no longer read, so
you get a clear "drop it again" rather than a wall of 403s. This matches the
MVP constraint that session-local access is sufficient.

**Same-origin exposure.** While a folder is mounted, any script running on this
origin can read every file under it through `_local/`. Mount ids are random and
unguessable, which prevents *guessing* a namespace, but it is not a security
boundary against code already running on the page. Only mount folders you are
willing to expose to this origin, and use "Unmount all" when finished.

**Read-only.** No writes, ever. The worker rejects everything but `GET` and
`HEAD`.

**No directory listings.** `_local/` exposes files only; a directory request
returns 404. Zarr does not need listings, but a tool that relies on them would
not work here.

**External viewers cannot be used.** Avivator, the OME-Zarr validator and
similar hosted tools cannot fetch a URL that only resolves inside this browser
profile. Only same-origin viewers work, which is why both are bundled.

**Previews need a portal page open.** They are rendered by a page on the
service worker's behalf, so a gallery left open in its own tab after the portal
was closed falls back to placeholder icons. Reopening the portal restores them.

**Large plates are capped.** Discovery stops after 1000 images (and other
bounds) and reports that it did.

**Cache invalidation is coarse.** Directory handles are cached until a mount is
removed, so restructuring a folder on disk mid-session may need a reload.

## Layout

```
index.html                  landing page
neuroglancer/index.html     bundled Neuroglancer
zarrcade/local-data.css     hides Zarrcade controls that need public URLs
public/zarrcade/            vendored Zarrcade SPA (gitignored; see scripts/)
src/
  main.ts                   entry
  ui/                       landing-page UX
  mounts/                   drag-and-drop -> handles -> mounts
  vfs/
    sw.ts                   Service Worker: lifecycle, storage, handle cache
    serve.ts                HTTP semantics (paths, ranges, status codes)
    client.ts               registration, base-path derivation, session docs
    idb.ts, protocol.ts     storage and the page/worker contract
  discovery/                OME-Zarr discovery
  preview/                  on-demand gallery previews
    policy.ts               when a preview is worth generating
    render.ts               lowest-resolution level -> projection -> PNG
    worker.ts, host.ts      dedicated worker and its page-side host
  integrations/             Neuroglancer state, Zarrcade config + catalog
tests/                      unit tests (`npm test`)
tests/browser/              end-to-end in Chrome (`npm run test:browser`)
```

Unit tests run in Node against a `FileSystemDirectoryHandle` adapter backed by
`node:fs` (`tests/node-handles.ts`) and real on-disk OME-Zarr fixtures, which
covers discovery and the HTTP layer without a browser.

The browser tests drive real Chrome against a production build served from a
subpath, so they also cover the GitHub Pages deployment shape. They build an
OME-Zarr in **OPFS** and register it as a mount: an OPFS handle is an ordinary
`FileSystemDirectoryHandle`, so the worker, Neuroglancer and Zarrcade all
exercise the real path. What they cannot cover is the drag-and-drop handle
acquisition itself, which needs a human — see [Limitations](#limitations).

## Licensing

This portal is a thin integration layer. Neuroglancer is Apache-2.0, Zarrcade is
BSD-3-Clause; both are consumed as unmodified published packages.

[ng]: https://github.com/google/neuroglancer
[zc]: https://github.com/JaneliaSciComp/zarrcade
[thumb]: https://github.com/clbarnes/zarr-convention-thumbnails
[zarrita]: https://github.com/manzt/zarrita.js
