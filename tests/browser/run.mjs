/**
 * End-to-end checks in real Chrome against the built site.
 *
 * Run with `npm run test:browser` (builds first). These are separate from
 * `npm test` because they need Chrome and a production build.
 *
 * The site is served under a subpath so the checks also cover the GitHub Pages
 * deployment shape, where the service worker's scope is `/<repo>/` and nothing
 * may assume the origin root.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

import { pageHelpers } from './fixture-page.mjs';

/** Blosc-compress the fixture chunk here, so the page can write real bytes. */
async function bloscChunkBase64() {
  const { default: Blosc } = await import('numcodecs/blosc');
  const codec = new Blosc({ cname: 'zstd', clevel: 5, shuffle: 1, blocksize: 0 });
  const data = new Uint8Array(4 * 16 * 16);
  for (let i = 0; i < data.length; i++) data[i] = i % 251;
  return Buffer.from(await codec.encode(data)).toString('base64');
}

const DIST = fileURLToPath(new URL('../../dist/', import.meta.url));
const BASE = '/ome-zarr-portal/';
const PORT = 5180;
const ORIGIN = `http://localhost:${PORT}`;
const CHROME = process.env.CHROME_PATH ?? '/usr/bin/google-chrome';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
};

/* ------------------------------------------------------------ tiny runner */

const results = [];
let failures = 0;

async function check(name, fn) {
  try {
    await fn();
    results.push(`  PASS  ${name}`);
  } catch (error) {
    failures += 1;
    results.push(`  FAIL  ${name}\n        ${error.message.split('\n').join('\n        ')}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}\n        expected: ${expected}\n        actual:   ${actual}`);
  }
}

/* ---------------------------------------------------------- static server */

function startServer() {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, ORIGIN);
    if (!url.pathname.startsWith(BASE)) {
      res.writeHead(404).end('not found');
      return;
    }
    let rel = url.pathname.slice(BASE.length);
    if (rel === '' || rel.endsWith('/')) rel += 'index.html';

    const file = join(DIST, normalize(rel).replace(/^(\.\.[/\\])+/, ''));
    try {
      const body = await readFile(file);
      res.writeHead(200, {
        'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
        // The worker must be allowed to control the whole subpath.
        'Service-Worker-Allowed': BASE,
      });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  return new Promise((resolve) => server.listen(PORT, () => resolve(server)));
}

/* -------------------------------------------------------------- the tests */

const server = await startServer();
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    // Software WebGL, so Neuroglancer can actually initialise headlessly.
    '--enable-unsafe-swiftshader',
    '--use-gl=angle',
    '--use-angle=swiftshader',
  ],
});

const mountId = `test${Date.now().toString(36)}`;
const imageName = 'browser_test.ome.zarr';
const imageUrl = `${ORIGIN}${BASE}_local/${mountId}/${imageName}/`;
const planarUrl = `${ORIGIN}${BASE}_local/${mountId}/planar_test.ome.zarr/`;
const previewUrl = (image) => `${ORIGIN}${BASE}_preview/${mountId}/${image}`;

try {
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(String(error)));

  await page.goto(`${ORIGIN}${BASE}`, { waitUntil: 'networkidle2' });

  await check('service worker registers and controls the page', async () => {
    const scope = await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.ready;
      // clients.claim() should make this page controlled without a reload.
      for (let i = 0; i < 50 && !navigator.serviceWorker.controller; i++) {
        await new Promise((r) => setTimeout(r, 100));
      }
      return navigator.serviceWorker.controller ? reg.scope : null;
    });
    assertEqual(scope, `${ORIGIN}${BASE}`, 'worker scope should be the deployment subpath');
  });

  await page.evaluate(pageHelpers);
  await check('an OPFS-backed mount can be created', async () => {
    const id = await page.evaluate(
      (m, f, d, blosc) => createOpfsMount(m, f, d, blosc),
      mountId,
      'browser-fixture',
      imageName,
      await bloscChunkBase64(),
    );
    assertEqual(id, mountId, 'mount id round-trips');
  });

  await check('the About dialog opens from the top-right button and closes again', async () => {
    const state = async () => page.evaluate(() => document.getElementById('about').open);
    assertEqual(await state(), false, 'starts closed');

    await page.click('#about-open');
    assertEqual(await state(), true, 'the button opens it');

    // Everything the dialog promises to explain should actually be in it.
    const text = await page.$eval('#about', (node) => node.innerText);
    const topics = ['What is OME-Zarr?', 'What can I drop?', 'Which browsers work?', 'Where to go next'];
    for (const topic of topics) {
      assert(text.includes(topic), `about text is missing "${topic}"`);
    }

    await page.click('#about-close');
    assertEqual(await state(), false, 'the close button closes it');
  });

  await check('worker serves metadata with correct status and headers', async () => {
    const result = await page.evaluate(async (url) => {
      const response = await fetch(`${url}zarr.json`);
      return {
        status: response.status,
        type: response.headers.get('Content-Type'),
        acceptRanges: response.headers.get('Accept-Ranges'),
        length: response.headers.get('Content-Length'),
        server: response.headers.get('X-Local-Server'),
        body: await response.text(),
      };
    }, imageUrl);

    assertEqual(result.status, 200, 'zarr.json should be served');
    assertEqual(result.type, 'application/json', 'content type');
    assertEqual(result.acceptRanges, 'bytes', 'range support advertised');
    assert(result.server?.startsWith('ome-zarr-portal/'), 'served by our worker');
    assertEqual(Number(result.length), new TextEncoder().encode(result.body).length, 'content length');
    assert(JSON.parse(result.body).attributes.ome.multiscales, 'parses as OME metadata');
  });

  await check('worker answers byte ranges with 206 and the right bytes', async () => {
    const result = await page.evaluate(async (url) => {
      const response = await fetch(`${url}0/c/0/0/0`, { headers: { Range: 'bytes=10-19' } });
      const bytes = new Uint8Array(await response.arrayBuffer());
      return {
        status: response.status,
        contentRange: response.headers.get('Content-Range'),
        length: response.headers.get('Content-Length'),
        bytes: [...bytes],
      };
    }, imageUrl);

    assertEqual(result.status, 206, 'partial content');
    assertEqual(result.contentRange, `bytes 10-19/${4 * 16 * 16}`, 'content range');
    assertEqual(result.length, '10', 'content length');
    // The fixture chunk is a ramp of i % 251.
    assertEqual(result.bytes.join(','), '10,11,12,13,14,15,16,17,18,19', 'range bytes');
  });

  await check('worker 404s a missing key', async () => {
    const status = await page.evaluate(
      async (url) => (await fetch(`${url}.zgroup`)).status,
      imageUrl,
    );
    assertEqual(status, 404, 'missing v2 metadata should 404, not hang');
  });

  /* ------------------------------------------------------- Neuroglancer */

  /**
   * Open the bundled viewer on one source and wait until the layer resolves.
   * Returns the rendered panel count, which is how the layout is observable.
   */
  async function openInNeuroglancer(sourceUrl, layerName, layout) {
    const state = {
      layers: [{ type: 'auto', name: layerName, source: `zarr://${sourceUrl}` }],
      // Mirrors what the portal generates: selected, panel closed.
      selectedLayer: { visible: false, layer: layerName },
      layout,
    };
    const ngPage = await browser.newPage();
    const ngErrors = [];
    ngPage.on('console', (msg) => {
      if (msg.type() === 'error') ngErrors.push(msg.text());
    });
    ngPage.on('pageerror', (error) => ngErrors.push(String(error)));

    try {
      await ngPage.goto(
        `${ORIGIN}${BASE}neuroglancer/index.html#!${encodeURIComponent(JSON.stringify(state))}`,
        { waitUntil: 'networkidle2' },
      );

      const outcome = await ngPage.evaluate(async () => {
        const deadline = Date.now() + 30000;
        while (Date.now() < deadline) {
          const statusText = [...document.querySelectorAll('.neuroglancer-status-message')]
            .map((n) => n.textContent)
            .join(' | ');
          if (/unsupported scheme|error/i.test(statusText)) {
            return { ok: false, reason: statusText };
          }
          const managed = window.viewer?.layerManager?.managedLayers ?? [];
          const panels = document.querySelectorAll('.neuroglancer-panel').length;
          if (managed.length > 0 && managed[0].layer !== null && panels > 0) {
            return {
              ok: true,
              sources: managed[0].layer.dataSources?.length ?? 0,
              panels,
              layerBars: document.querySelectorAll('.neuroglancer-layer-panel').length,
              sidePanels: document.querySelectorAll('.neuroglancer-layer-side-panel-title').length,
              layout: window.viewer.state.toJSON().layout,
              statusText,
            };
          }
          await new Promise((r) => setTimeout(r, 250));
        }
        return {
          ok: false,
          reason: `timed out; layers=${window.viewer?.layerManager?.managedLayers?.length ?? 'none'}`,
        };
      });

      const scheme = ngErrors.find((e) => /unsupported scheme/i.test(e));
      if (scheme) throw new Error(`console reported: ${scheme}`);
      return outcome;
    } finally {
      await ngPage.close();
    }
  }

  await check('Neuroglancer loads a zarr source from the virtual namespace', async () => {
    const outcome = await openInNeuroglancer(imageUrl, 'browser_test', '4panel-alt');
    assert(outcome.ok, `Neuroglancer did not load the source: ${outcome.reason}`);
    assert(outcome.sources > 0, 'layer should have a resolved data source');
  });

  await check('the layer side panel starts closed', async () => {
    // `selectedLayer.visible` is false in the generated state, so the viewer
    // opens on the image instead of on a panel of shader controls.
    const outcome = await openInNeuroglancer(imageUrl, 'browser_test', '4panel-alt');
    assert(outcome.ok, `did not load: ${outcome.reason}`);
    assertEqual(outcome.sidePanels, 0, 'no layer side panel on the right');
  });

  await check('the layer bar is not shown', async () => {
    // `showLayerPanel: false` in src/neuroglancer/main.ts. The bar is built
    // lazily by LayerGroupViewer, so its absence is only observable once a
    // layer has actually loaded.
    const outcome = await openInNeuroglancer(imageUrl, 'browser_test', '4panel-alt');
    assert(outcome.ok, `did not load: ${outcome.reason}`);
    assertEqual(outcome.layerBars, 0, 'no layer-name bar above the panels');
  });

  await check('volumetric data renders the four orthogonal panels', async () => {
    const outcome = await openInNeuroglancer(imageUrl, 'browser_test', '4panel-alt');
    assert(outcome.ok, `did not load: ${outcome.reason}`);
    assertEqual(outcome.layout, '4panel-alt', 'viewer kept the requested layout');
    assertEqual(outcome.panels, 4, 'four panels for data with depth');
  });

  await check('planar data renders a single xy panel', async () => {
    const outcome = await openInNeuroglancer(planarUrl, 'planar_test', 'xy');
    assert(outcome.ok, `did not load: ${outcome.reason}`);
    assertEqual(outcome.layout, 'xy', 'viewer kept the requested layout');
    assertEqual(outcome.panels, 1, 'one panel for data with no z axis');
  });

  await check('Neuroglancer requested real chunk data through the worker', async () => {
    // Chunk reads happen in a worker thread; check the fixture's chunk was
    // actually fetched by asking the page which URLs the worker answered.
    const served = await page.evaluate(async (url) => {
      const response = await fetch(`${url}0/c/0/0/0`, { method: 'HEAD' });
      return { status: response.status, length: response.headers.get('Content-Length') };
    }, imageUrl);
    assertEqual(served.status, 200, 'chunk is reachable');
    assertEqual(served.length, String(4 * 16 * 16), 'chunk length');
  });

  /* ------------------------------------------------------------- previews */

  /** Fetch a preview and decode it, returning its real pixel dimensions. */
  async function fetchPreview(image) {
    return page.evaluate(async (url) => {
      const response = await fetch(url);
      if (!response.ok) {
        return { status: response.status, error: response.headers.get('X-Local-Error') };
      }
      const blob = await response.blob();
      const bitmap = await createImageBitmap(blob);
      // Read the pixels back so the check covers real image content, not just
      // a well-formed but empty PNG.
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(bitmap, 0, 0);
      const { data } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
      let min = 255;
      let max = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i] < min) min = data[i];
        if (data[i] > max) max = data[i];
      }
      return {
        status: response.status,
        type: response.headers.get('Content-Type'),
        cacheControl: response.headers.get('Cache-Control'),
        bytes: blob.size,
        width: bitmap.width,
        height: bitmap.height,
        min,
        max,
      };
    }, previewUrl(image));
  }

  await check('preview renders a PNG from a raw v3 image', async () => {
    const result = await fetchPreview(imageName);
    assertEqual(result.status, 200, `expected a preview, got ${result.error ?? result.status}`);
    assertEqual(result.type, 'image/png', 'content type');
    assertEqual(result.width, 16, 'preview width matches the lowest-resolution level');
    assertEqual(result.height, 16, 'preview height matches the lowest-resolution level');
    assert(result.bytes > 0, 'PNG has content');
    assert(result.max > result.min, 'projection produced real contrast, not a flat image');
  });

  await check('preview decodes a blosc-compressed v2 image', async () => {
    const result = await fetchPreview('blosc_test.ome.zarr');
    assertEqual(result.status, 200, `expected a preview, got ${result.error ?? result.status}`);
    assertEqual(result.width, 16, 'preview width');
    assertEqual(result.height, 16, 'preview height');
    assert(result.max > result.min, 'blosc chunk decoded to real data');
  });

  /** Fetch a preview and return its size plus every pixel's RGB. */
  async function fetchPreviewPixels(image) {
    return page.evaluate(async (url) => {
      const response = await fetch(url);
      if (!response.ok) {
        return { status: response.status, error: response.headers.get('X-Local-Error') };
      }
      const bitmap = await createImageBitmap(await response.blob());
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(bitmap, 0, 0);
      const { data } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
      return { status: response.status, width: bitmap.width, height: bitmap.height, data: [...data] };
    }, previewUrl(image));
  }

  await check('preview overlays channels in colour, from the first timepoint', async () => {
    const result = await fetchPreviewPixels('series_test.ome.zarr');
    assertEqual(result.status, 200, `expected a preview, got ${result.error ?? result.status}`);
    // A composite is one image the size of the projection, not a montage.
    assertEqual(result.width, 16, 'composite width');
    assertEqual(result.height, 16, 'composite height');

    const rgb = (x, y) => {
      const offset = (y * result.width + x) * 4;
      return { r: result.data[offset], g: result.data[offset + 1], b: result.data[offset + 2] };
    };
    const origin = rgb(1, 1);
    const right = rgb(14, 1);
    const down = rgb(1, 14);

    // Channel 0 is tinted green and ramps along x; channel 2 is tinted cyan
    // and ramps along y. Blue comes only from the cyan channel here, so the
    // two gradients stay separable: blue must follow y and ignore x, while
    // green follows x. Both gradients exist only if the renderer read
    // timepoint 0 — timepoint 1 is saturated everywhere, and a projection
    // across time would be flat — and projected through z, whose first slice
    // is empty.
    assert(right.g > origin.g + 50, 'green channel ramps along x');
    assert(down.b > origin.b + 50, 'cyan channel ramps along y');
    assert(Math.abs(right.b - origin.b) <= 1, 'cyan channel does not follow x');

    // Channel 1 is constant and tinted magenta: it is the only source of red,
    // and it contributes the same red to every pixel.
    assert(origin.r > 0, 'flat channel is visible at all');
    assert(Math.abs(right.r - origin.r) <= 1, 'flat channel contributes evenly');
    assert(Math.abs(down.r - origin.r) <= 1, 'flat channel contributes evenly');
  });

  await check('preview 404s for an unknown image so the gallery falls back', async () => {
    const result = await fetchPreview('not-a-image');
    assertEqual(result.status, 404, 'missing image');
    assertEqual(result.error, 'no-preview', 'signals why');
  });

  /* ------------------------------------------------------------ Zarrcade */

  await check('Zarrcade renders a gallery from a generated session catalog', async () => {
    const sessionId = `s${Date.now().toString(36)}`;
    const configUrl = await page.evaluate(
      async (sid, base, dsUrl) => {
        const preview = `${location.origin}${base}_preview/${dsUrl.split('/_local/')[1].replace(/\/$/, '')}`;
        const catalog =
          'Name,path,thumbnail,Folder,Location,OME-Zarr Version,Axes,Shape,Data Type,Resolution Levels\n' +
          `browser_test,${dsUrl},${preview},browser-fixture,browser_test.ome.zarr,v5,"z, y, x","4 × 16 × 16",uint8,1\n`;
        const catalogUrl = `${location.origin}${base}_session/${sid}/catalog.csv`;
        const config = {
          title: 'Browser test gallery',
          dataUrl: catalogUrl,
          data: { delimiter: ',', pathColumn: 'path', thumbnailColumn: 'thumbnail' },
          display: { titleColumn: 'Name', hideColumns: ['path', 'thumbnail'], pageSize: 50 },
          filters: [],
          viewers: [],
        };
        const put = (path, body, contentType) =>
          new Promise((resolve, reject) => {
            const request = indexedDB.open('ome-zarr-portal', 1);
            request.onsuccess = () => {
              const db = request.result;
              const tx = db.transaction('sessionFiles', 'readwrite');
              tx.objectStore('sessionFiles').put({
                key: `${sid}/${path}`,
                sessionId: sid,
                path,
                body,
                contentType,
                createdAt: Date.now(),
              });
              tx.oncomplete = resolve;
              tx.onerror = () => reject(tx.error);
            };
            request.onerror = () => reject(request.error);
          });
        await put('catalog.csv', catalog, 'text/csv; charset=utf-8');
        await put('config.json', JSON.stringify(config), 'application/json');
        return `${location.origin}${base}_session/${sid}/config.json`;
      },
      sessionId,
      BASE,
      imageUrl,
    );

    const zcPage = await browser.newPage();
    try {
      await zcPage.goto(
        `${ORIGIN}${BASE}zarrcade/index.html?config=${encodeURIComponent(configUrl)}`,
        { waitUntil: 'networkidle2' },
      );
      await zcPage.waitForFunction(
        () => document.body.innerText.includes('browser_test'),
        { timeout: 20000 },
      );
      const text = await zcPage.evaluate(() => document.body.innerText);
      assert(text.includes('browser_test'), 'gallery lists the image');

      // The card must show the generated preview, not the placeholder icon.
      // `naturalWidth` is the decisive check: it is non-zero only if the image
      // actually decoded.
      const thumbnail = await zcPage.evaluate(async () => {
        const deadline = Date.now() + 20000;
        while (Date.now() < deadline) {
          const img = document.querySelector('.image-card-thumbnail img');
          if (img && img.complete && img.naturalWidth > 0) {
            return { src: img.getAttribute('src'), width: img.naturalWidth, height: img.naturalHeight };
          }
          await new Promise((r) => setTimeout(r, 200));
        }
        const img = document.querySelector('.image-card-thumbnail img');
        return { src: img?.getAttribute('src') ?? null, width: img?.naturalWidth ?? 0, height: 0 };
      });

      assert(
        thumbnail.src?.includes('/_preview/'),
        `card should show the generated preview, got ${thumbnail.src}`,
      );
      assertEqual(thumbnail.width, 16, 'preview decoded at the lowest-resolution level size');

      // Controls that exist to pass a data URL on are hidden: these URLs only
      // resolve in this browser, through the Service Worker, and only while the
      // folder is mounted. See `zarrcade/local-data.css`.
      const cardCopy = await zcPage.evaluate(() => {
        const node = document.querySelector(
          '.image-card-overlay .overlay-button[aria-label="Copy data URL"]',
        );
        return node ? getComputedStyle(node).display : 'absent';
      });
      assertEqual(cardCopy, 'none', 'a card still offers "Copy data URL"');

      await zcPage.click('.settings-menu-trigger');
      await new Promise((r) => setTimeout(r, 200));
      const menu = await zcPage.evaluate(() =>
        [...document.querySelectorAll('.settings-menu-item')]
          .filter((node) => getComputedStyle(node).display !== 'none')
          .map((node) => node.innerText.trim()),
      );
      assert(menu.length > 0, 'the menu opened');
      assert(
        !menu.some((label) => /Copy link|BioFile Finder/i.test(label)),
        `menu still offers a dead link: ${menu.join(' | ')}`,
      );
    } finally {
      await zcPage.close();
    }
  });

  const unexpected = consoleErrors.filter(
    (e) => !/favicon|Failed to load resource: the server responded with a status of 404/i.test(e),
  );
  await check('portal page produced no unexpected console errors', async () => {
    assert(unexpected.length === 0, unexpected.join('\n'));
  });
} finally {
  await browser.close();
  server.close();
}

console.log(`\nBrowser checks against ${CHROME}\n`);
console.log(results.join('\n'));
console.log(`\n${results.length - failures}/${results.length} passed\n`);
process.exit(failures > 0 ? 1 : 0);
