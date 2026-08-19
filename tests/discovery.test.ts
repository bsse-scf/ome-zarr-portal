import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { join } from 'node:path';

import { discoverInMount } from '../src/discovery/discover';
import type { DiscoveredDataset, DiscoveryResult } from '../src/discovery/types';
import type { Mount } from '../src/mounts/registry';
import { makeFixture, type Fixture } from './fixtures';
import { directoryHandle } from './node-handles';

const urlBuilder = (mountId: string, relativePath: string) =>
  `https://example.test/_local/${mountId}/${relativePath}`;

function mountFor(path: string, name: string): Mount {
  return { id: 'm1', name, handle: directoryHandle(path, name), createdAt: 0 };
}

function byName(result: DiscoveryResult, name: string): DiscoveredDataset {
  const found = result.datasets.find((dataset) => dataset.name === name);
  assert.ok(found, `expected a dataset named ${name}, got ${result.datasets.map((d) => d.name).join(', ')}`);
  return found;
}

describe('OME-Zarr discovery', () => {
  let fixture: Fixture;
  let result: DiscoveryResult;

  before(async () => {
    fixture = await makeFixture();
    result = await discoverInMount(mountFor(fixture.root, 'drop'), { urlBuilder });
  });

  after(async () => {
    await fixture.cleanup();
  });

  it('finds every multiscale image and nothing else', () => {
    assert.deepEqual(
      result.datasets.map((dataset) => dataset.relativePath).sort(),
      [
        'big-pyramid.ome.zarr',
        'nested/deeper/v3-image.ome.zarr',
        'plate.ome.zarr/A/1/0',
        'thumbed.ome.zarr',
        'time-series.ome.zarr',
        'v2-image.ome.zarr',
      ],
    );
  });

  it('never reports a dataset nested inside another dataset', () => {
    // The v2 image has levels `0` and `1`, each a Zarr array with chunk
    // directories below it; none may surface as a dataset of its own. Testing
    // containment rather than path shape also covers a plate's fields of view,
    // which legitimately sit at paths like `A/1/0`.
    for (const outer of result.datasets) {
      for (const inner of result.datasets) {
        if (outer === inner) continue;
        assert.equal(
          inner.relativePath.startsWith(`${outer.relativePath}/`),
          false,
          `${inner.relativePath} is nested inside ${outer.relativePath}`,
        );
      }
    }
  });

  it('stops at the multiscale root instead of walking its chunk tree', () => {
    // 12 folders: the drop root, three dataset roots, and the plain folders
    // leading to them. If the walk descended into resolution levels or chunk
    // directories this number would be far larger.
    assert.ok(
      result.directoriesScanned < 25,
      `scanned ${result.directoriesScanned} folders, expected the walk to stop at dataset roots`,
    );
  });

  it('reads v2 metadata, including axes and array shape', () => {
    const dataset = byName(result, 'v2-image');
    assert.equal(dataset.zarrFormat, 2);
    assert.equal(dataset.omeZarrVersion, '0.4');
    assert.deepEqual(dataset.axes, ['c', 'y', 'x']);
    assert.deepEqual(dataset.shape, [2, 64, 64]);
    assert.equal(dataset.dtype, '<u2');
    assert.equal(dataset.scaleCount, 2);
  });

  it('reads v3 metadata nested under attributes.ome', () => {
    const dataset = byName(result, 'v3-image');
    assert.equal(dataset.zarrFormat, 3);
    assert.equal(dataset.omeZarrVersion, '0.5');
    assert.deepEqual(dataset.axes, ['z', 'y', 'x']);
    assert.deepEqual(dataset.shape, [8, 32, 32]);
    assert.equal(dataset.dtype, 'uint8');
  });

  it('builds virtual URLs with a trailing slash', () => {
    for (const dataset of result.datasets) {
      assert.ok(dataset.virtualUrl.endsWith('/'), dataset.virtualUrl);
      assert.equal(dataset.virtualUrl, `${urlBuilder('m1', dataset.relativePath)}/`);
    }
  });

  it('walks into a plate and says so', () => {
    const note = result.notes.find((entry) => entry.path.endsWith('plate.ome.zarr'));
    assert.ok(note, 'expected a note about the plate');
    assert.equal(note.kind, 'skipped');
    assert.match(note.message, /plate/i);
  });

  it('ignores a bare array without reporting it below the drop root', () => {
    assert.equal(
      result.datasets.some((dataset) => dataset.relativePath.includes('bare-array')),
      false,
    );
    assert.equal(
      result.notes.some((note) => note.path.includes('bare-array')),
      false,
    );
  });

  it('treats a dropped dataset root as a single dataset', async () => {
    const single = await discoverInMount(
      mountFor(join(fixture.root, 'v2-image.ome.zarr'), 'v2-image.ome.zarr'),
      { urlBuilder },
    );
    assert.equal(single.datasets.length, 1);
    assert.equal(single.datasets[0].relativePath, '');
    assert.equal(single.datasets[0].name, 'v2-image');
    assert.equal(single.datasets[0].virtualUrl, 'https://example.test/_local/m1/');
  });

  it('reports a dropped bare array as unsupported', async () => {
    const single = await discoverInMount(
      mountFor(join(fixture.root, 'bare-array.zarr'), 'bare-array.zarr'),
      { urlBuilder },
    );
    assert.equal(single.datasets.length, 0);
    assert.equal(single.notes.length, 1);
    assert.equal(single.notes[0].kind, 'unsupported');
    assert.match(single.notes[0].message, /bare Zarr array/);
  });

  it('marks a dataset previewable when its coarsest level is small', () => {
    // v2-image bottoms out at 2 x 32 x 32.
    const dataset = byName(result, 'v2-image');
    assert.equal(dataset.previewable, true);
    assert.equal(dataset.hasConventionThumbnail, false);
  });

  it('refuses a preview when the coarsest level is still huge', () => {
    // 8192 x 8192 uint16 exceeds both the byte budget and the extent cap, and
    // the judgement is made from metadata alone — no chunk is read.
    const dataset = byName(result, 'big-pyramid');
    assert.equal(dataset.previewable, false);
  });

  it('judges a time series by one timepoint, not by the whole series', () => {
    // 200 x 3 x 256 x 256 uint16 is 78 MB in total but 384 KB per timepoint,
    // and only the first timepoint is ever read.
    const dataset = byName(result, 'time-series');
    assert.equal(dataset.previewable, true);
  });

  it('defers to a dataset that ships its own thumbnails', () => {
    const dataset = byName(result, 'thumbed');
    assert.equal(dataset.hasConventionThumbnail, true);
    // No preview needed: Zarrcade reads the convention itself.
    assert.equal(dataset.previewable, false);
  });

  it('honours the dataset limit and reports it', async () => {
    const limited = await discoverInMount(mountFor(fixture.root, 'drop'), {
      urlBuilder,
      limits: { maxDatasets: 1 },
    });
    assert.equal(limited.datasets.length, 1);
    assert.ok(limited.notes.some((note) => note.kind === 'limit'));
  });

  it('stops at the depth limit rather than walking forever', async () => {
    const shallow = await discoverInMount(mountFor(fixture.root, 'drop'), {
      urlBuilder,
      limits: { maxDepth: 1 },
    });
    assert.deepEqual(
      shallow.datasets.map((dataset) => dataset.relativePath).sort(),
      ['big-pyramid.ome.zarr', 'thumbed.ome.zarr', 'time-series.ome.zarr', 'v2-image.ome.zarr'],
    );
    assert.ok(shallow.notes.some((note) => note.kind === 'limit'));
  });

  it('reports progress as it walks', async () => {
    const seen: number[] = [];
    await discoverInMount(mountFor(fixture.root, 'drop'), {
      urlBuilder,
      onProgress: (progress) => seen.push(progress.directoriesScanned),
    });
    assert.ok(seen.length > 1);
    assert.deepEqual(seen, [...seen].sort((a, b) => a - b));
  });
});
