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
const datasetName = 'browser_test.ome.zarr';
const datasetUrl = `${ORIGIN}${BASE}_local/${mountId}/${datasetName}/`;

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
      (m, f, d) => createOpfsMount(m, f, d),
      mountId,
      'browser-fixture',
      datasetName,
    );
    assertEqual(id, mountId, 'mount id round-trips');
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
    }, datasetUrl);

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
    }, datasetUrl);

    assertEqual(result.status, 206, 'partial content');
    assertEqual(result.contentRange, `bytes 10-19/${4 * 16 * 16}`, 'content range');
    assertEqual(result.length, '10', 'content length');
    // The fixture chunk is a ramp of i % 251.
    assertEqual(result.bytes.join(','), '10,11,12,13,14,15,16,17,18,19', 'range bytes');
  });

  await check('worker 404s a missing key', async () => {
    const status = await page.evaluate(
      async (url) => (await fetch(`${url}.zgroup`)).status,
      datasetUrl,
    );
    assertEqual(status, 404, 'missing v2 metadata should 404, not hang');
  });

  /* ------------------------------------------------------- Neuroglancer */

  await check('Neuroglancer loads a zarr source from the virtual namespace', async () => {
    const state = {
      layers: [{ type: 'auto', name: 'browser_test', source: `zarr://${datasetUrl}` }],
      selectedLayer: { visible: true, layer: 'browser_test' },
      layout: '4panel-alt',
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
          if (managed.length > 0 && managed[0].layer !== null && managed[0].isReady?.() !== false) {
            const layer = managed[0].layer;
            return {
              ok: true,
              layerType: layer.constructor?.name,
              sources: layer.dataSources?.length ?? 0,
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

      assert(outcome.ok, `Neuroglancer did not load the source: ${outcome.reason}`);
      assert(outcome.sources > 0, 'layer should have a resolved data source');

      const scheme = ngErrors.find((e) => /unsupported scheme/i.test(e));
      assert(!scheme, `console reported: ${scheme}`);
    } finally {
      await ngPage.close();
    }
  });

  await check('Neuroglancer requested real chunk data through the worker', async () => {
    // Chunk reads happen in a worker thread; check the fixture's chunk was
    // actually fetched by asking the page which URLs the worker answered.
    const served = await page.evaluate(async (url) => {
      const response = await fetch(`${url}0/c/0/0/0`, { method: 'HEAD' });
      return { status: response.status, length: response.headers.get('Content-Length') };
    }, datasetUrl);
    assertEqual(served.status, 200, 'chunk is reachable');
    assertEqual(served.length, String(4 * 16 * 16), 'chunk length');
  });

  /* ------------------------------------------------------------ Zarrcade */

  await check('Zarrcade renders a gallery from a generated session catalog', async () => {
    const sessionId = `s${Date.now().toString(36)}`;
    const configUrl = await page.evaluate(
      async (sid, base, dsUrl) => {
        const catalog =
          'Name,path,Folder,Location,NGFF Version,Zarr Format,Axes,Shape,Data Type,Levels\n' +
          `browser_test,${dsUrl},browser-fixture,browser_test.ome.zarr,0.5,v3,"z, y, x","4 × 16 × 16",uint8,1\n`;
        const catalogUrl = `${location.origin}${base}_session/${sid}/catalog.csv`;
        const config = {
          title: 'Browser test gallery',
          dataUrl: catalogUrl,
          data: { delimiter: ',', pathColumn: 'path' },
          display: { titleColumn: 'Name', hideColumns: ['path'], pageSize: 50 },
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
      datasetUrl,
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
      assert(text.includes('browser_test'), 'gallery lists the dataset');
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
