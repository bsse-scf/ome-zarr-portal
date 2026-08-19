import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { parsePath, parseRange, serveLocal, serveSession } from '../src/vfs/serve';
import { makeFixture, type Fixture } from './fixtures';
import { directoryHandle } from './node-handles';

const PREFIX = '/portal/_local/';
const SESSION_PREFIX = '/portal/_session/';

describe('path parsing', () => {
  it('splits a namespaced path into mount id and segments', () => {
    const parsed = parsePath('/portal/_local/abc123/img.ome.zarr/0/c/0/0/0', PREFIX);
    assert.deepEqual(parsed, {
      id: 'abc123',
      segments: ['img.ome.zarr', '0', 'c', '0', '0', '0'],
      trailingSlash: false,
    });
  });

  it('decodes percent-encoded segments', () => {
    const parsed = parsePath(`${PREFIX}abc/my%20folder/a%2Bb.json`, PREFIX);
    assert.deepEqual(parsed?.segments, ['my folder', 'a+b.json']);
  });

  it('records a trailing slash', () => {
    assert.equal(parsePath(`${PREFIX}abc/img.ome.zarr/`, PREFIX)?.trailingSlash, true);
  });

  it('refuses paths that could escape the mount', () => {
    assert.equal(parsePath(`${PREFIX}abc/../../etc/passwd`, PREFIX), null);
    assert.equal(parsePath(`${PREFIX}abc/%2e%2e/secret`, PREFIX), null);
    assert.equal(parsePath(`${PREFIX}abc/%2Fetc%2Fpasswd`, PREFIX), null);
    assert.equal(parsePath(`${PREFIX}abc/%ff`, PREFIX), null);
  });

  it('rejects a path outside the namespace or with no mount', () => {
    assert.equal(parsePath('/elsewhere/abc/file', PREFIX), null);
    assert.equal(parsePath(PREFIX, PREFIX), null);
  });
});

describe('range parsing', () => {
  it('ignores an absent or unusable header', () => {
    assert.equal(parseRange(null, 100), null);
    assert.equal(parseRange('items=0-10', 100), null);
    // Multiple ranges: answering with the full body is a valid alternative.
    assert.equal(parseRange('bytes=0-9,20-29', 100), null);
  });

  it('parses a closed range', () => {
    assert.deepEqual(parseRange('bytes=10-19', 100), { start: 10, end: 19 });
  });

  it('parses an open-ended range', () => {
    assert.deepEqual(parseRange('bytes=90-', 100), { start: 90, end: 99 });
  });

  it('clamps an end past the file size', () => {
    assert.deepEqual(parseRange('bytes=90-9999', 100), { start: 90, end: 99 });
  });

  it('parses a suffix range', () => {
    assert.deepEqual(parseRange('bytes=-10', 100), { start: 90, end: 99 });
    // A suffix longer than the file means the whole file.
    assert.deepEqual(parseRange('bytes=-500', 100), { start: 0, end: 99 });
  });

  it('flags ranges that cannot be satisfied', () => {
    assert.equal(parseRange('bytes=100-200', 100), 'unsatisfiable');
    assert.equal(parseRange('bytes=-0', 100), 'unsatisfiable');
  });
});

describe('serving local files', () => {
  let fixture: Fixture;
  let handle: FileSystemDirectoryHandle;

  const request = (path: string, init?: RequestInit) =>
    new Request(`https://example.test${path}`, init);

  const serve = (path: string, init?: RequestInit) => {
    const req = request(path, init);
    return serveLocal(req, new URL(req.url), {
      prefix: PREFIX,
      lookupMount: async (id) => (id === 'm1' ? { id, handle } : null),
    });
  };

  before(async () => {
    fixture = await makeFixture();
    handle = directoryHandle(fixture.root, 'drop');
  });

  after(async () => {
    await fixture.cleanup();
  });

  it('serves a metadata file with length, type and range support', async () => {
    const response = await serve(`${PREFIX}m1/v2-image.ome.zarr/.zattrs`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Content-Type'), 'application/json');
    assert.equal(response.headers.get('Accept-Ranges'), 'bytes');
    assert.equal(response.headers.get('X-Local-Mount'), 'm1');

    const body = await response.text();
    assert.equal(response.headers.get('Content-Length'), String(new Blob([body]).size));
    assert.ok(JSON.parse(body).multiscales);
  });

  it('serves an extensionless chunk as opaque bytes', async () => {
    const response = await serve(`${PREFIX}m1/v2-image.ome.zarr/0/0/0/0`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Content-Type'), 'application/octet-stream');
    assert.equal((await response.arrayBuffer()).byteLength, 64 * 64 * 2);
  });

  it('answers HEAD with headers and no body', async () => {
    const response = await serve(`${PREFIX}m1/v2-image.ome.zarr/0/0/0/0`, { method: 'HEAD' });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Content-Length'), String(64 * 64 * 2));
    assert.equal(await response.text(), '');
  });

  it('answers a byte range with 206 and the right bytes', async () => {
    const full = new Uint8Array(
      await (await serve(`${PREFIX}m1/v2-image.ome.zarr/0/0/0/0`)).arrayBuffer(),
    );
    const response = await serve(`${PREFIX}m1/v2-image.ome.zarr/0/0/0/0`, {
      headers: { Range: 'bytes=16-31' },
    });

    assert.equal(response.status, 206);
    assert.equal(response.headers.get('Content-Range'), `bytes 16-31/${full.length}`);
    assert.equal(response.headers.get('Content-Length'), '16');

    const slice = new Uint8Array(await response.arrayBuffer());
    assert.deepEqual([...slice], [...full.slice(16, 32)]);
  });

  it('answers a suffix range', async () => {
    const response = await serve(`${PREFIX}m1/v2-image.ome.zarr/.zgroup`, {
      headers: { Range: 'bytes=-3' },
    });
    assert.equal(response.status, 206);
    assert.equal((await response.text()).length, 3);
  });

  it('answers an unsatisfiable range with 416', async () => {
    const response = await serve(`${PREFIX}m1/v2-image.ome.zarr/.zgroup`, {
      headers: { Range: 'bytes=99999-' },
    });
    assert.equal(response.status, 416);
    assert.match(response.headers.get('Content-Range') ?? '', /^bytes \*\/\d+$/);
  });

  it('404s a missing file', async () => {
    const response = await serve(`${PREFIX}m1/v2-image.ome.zarr/zarr.json`);
    assert.equal(response.status, 404);
    assert.equal(response.headers.get('X-Local-Error'), 'not-found');
  });

  it('404s a directory rather than inventing a listing', async () => {
    const response = await serve(`${PREFIX}m1/v2-image.ome.zarr/0`);
    assert.equal(response.status, 404);
    assert.equal(response.headers.get('X-Local-Error'), 'is-directory');
  });

  it('404s an unknown mount with an actionable message', async () => {
    const response = await serve(`${PREFIX}nope/anything`);
    assert.equal(response.status, 404);
    assert.equal(response.headers.get('X-Local-Error'), 'unknown-mount');
    assert.match(await response.text(), /Drop the folder/);
  });

  it('rejects traversal attempts before touching the filesystem', async () => {
    const response = await serve(`${PREFIX}m1/../../../etc/passwd`);
    assert.equal(response.status, 400);
  });

  it('rejects methods other than GET and HEAD', async () => {
    const response = await serve(`${PREFIX}m1/v2-image.ome.zarr/.zgroup`, { method: 'POST' });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('Allow'), 'GET, HEAD');
  });

  it('reports a lost permission grant as 403', async () => {
    const denied = {
      async getDirectoryHandle() {
        throw new DOMException('denied', 'NotAllowedError');
      },
      async getFileHandle() {
        throw new DOMException('denied', 'NotAllowedError');
      },
    } as unknown as FileSystemDirectoryHandle;

    const req = request(`${PREFIX}m1/whatever.json`);
    const response = await serveLocal(req, new URL(req.url), {
      prefix: PREFIX,
      lookupMount: async (id) => ({ id, handle: denied }),
    });
    assert.equal(response.status, 403);
    assert.equal(response.headers.get('X-Local-Error'), 'permission-lost');
  });
});

describe('serving generated session documents', () => {
  const files = new Map([
    ['s1/config.json', { body: '{"dataUrl":"./catalog.csv"}', contentType: 'application/json' }],
  ]);

  const serve = (path: string, init?: RequestInit) => {
    const req = new Request(`https://example.test${path}`, init);
    return serveSession(req, new URL(req.url), {
      prefix: SESSION_PREFIX,
      lookupFile: async (key) => files.get(key) ?? null,
    });
  };

  it('serves a stored document', async () => {
    const response = await serve(`${SESSION_PREFIX}s1/config.json`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Content-Type'), 'application/json');
    assert.equal(JSON.parse(await response.text()).dataUrl, './catalog.csv');
  });

  it('404s an unknown document', async () => {
    assert.equal((await serve(`${SESSION_PREFIX}s1/missing.csv`)).status, 404);
  });
});
