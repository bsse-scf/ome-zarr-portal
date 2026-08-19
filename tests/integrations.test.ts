import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// `siteUrl` derives the deployment base from `location`, which Node lacks.
// Point it at a subpath deployment so the tests also cover the GitHub Pages
// case, where nothing may assume the site lives at the origin root.
(globalThis as unknown as { location: URL }).location = new URL('https://example.test/portal/');

import type { DiscoveredDataset } from '../src/discovery/types';
import {
  buildNeuroglancerState,
  neuroglancerUrl,
  neuroglancerUrlTemplate,
} from '../src/integrations/neuroglancer';
import { buildCatalogCsv, buildZarrcadeConfig } from '../src/integrations/zarrcade';

function dataset(overrides: Partial<DiscoveredDataset> = {}): DiscoveredDataset {
  return {
    id: 'm1:img.ome.zarr',
    name: 'img',
    relativePath: 'img.ome.zarr',
    virtualUrl: 'https://example.test/portal/_local/m1/img.ome.zarr/',
    omeZarrVersion: '0.4',
    mountId: 'm1',
    mountName: 'drop',
    zarrFormat: 2,
    axes: ['c', 'y', 'x'],
    shape: [2, 64, 64],
    dtype: '<u2',
    scaleCount: 3,
    ...overrides,
  };
}

/**
 * Zarrcade's own template substitution, copied from its `utils/viewers.ts`.
 * Reproducing it here pins the contract the portal depends on: if upstream
 * changes how templates are filled in, this test is where it shows up.
 */
function zarrcadeViewerUrl(template: string, dataUrl: string): string {
  const name = (dataUrl.replace(/\/+$/, '').split('/').pop() || 'image').replace(/\.zarr$/i, '');
  return template
    .split('{ENCODED_URL}')
    .join(encodeURIComponent(dataUrl))
    .split('{URL}')
    .join(dataUrl)
    .split('{NAME}')
    .join(name);
}

describe('Neuroglancer state', () => {
  it('makes one auto-typed zarr layer per dataset', () => {
    const state = buildNeuroglancerState([dataset(), dataset({ name: 'other', id: 'm1:other' })]);
    assert.equal(state.layers.length, 2);
    assert.equal(state.layers[0].type, 'auto');
    assert.equal(
      state.layers[0].source,
      'zarr://https://example.test/portal/_local/m1/img.ome.zarr/',
    );
    assert.deepEqual(state.selectedLayer, { visible: true, layer: 'img' });
  });

  it('disambiguates layers that share a folder name', () => {
    const state = buildNeuroglancerState([
      dataset(),
      dataset({ id: 'm2:img.ome.zarr', virtualUrl: 'https://example.test/portal/_local/m2/img.ome.zarr/' }),
      dataset({ id: 'm3:img.ome.zarr', virtualUrl: 'https://example.test/portal/_local/m3/img.ome.zarr/' }),
    ]);
    assert.deepEqual(
      state.layers.map((layer) => layer.name),
      ['img', 'img (2)', 'img (3)'],
    );
  });

  it('points at the bundled viewer, not a public instance', () => {
    const url = neuroglancerUrl([dataset()]);
    assert.ok(url.startsWith('https://example.test/portal/neuroglancer/index.html#!'), url);

    const state = JSON.parse(decodeURIComponent(url.slice(url.indexOf('#!') + 2)));
    assert.equal(state.layers[0].source, 'zarr://https://example.test/portal/_local/m1/img.ome.zarr/');
  });

  it('survives an empty dataset list without a dangling selection', () => {
    const state = buildNeuroglancerState([]);
    assert.deepEqual(state.layers, []);
    assert.equal(state.selectedLayer, undefined);
  });
});

describe('Zarrcade catalog', () => {
  it('emits a header and one row per dataset', () => {
    const csv = buildCatalogCsv([dataset(), dataset({ name: 'second', id: 'm1:second' })]);
    const lines = csv.trimEnd().split('\n');
    assert.equal(lines.length, 3);
    assert.equal(
      lines[0],
      'Name,path,Folder,Location,NGFF Version,Zarr Format,Axes,Shape,Data Type,Levels',
    );
    assert.ok(lines[1].startsWith('img,https://example.test/portal/_local/m1/img.ome.zarr/,drop,'));
  });

  it('quotes fields containing commas or quotes', () => {
    const csv = buildCatalogCsv([dataset({ name: 'a,b "c"' })]);
    const row = csv.trimEnd().split('\n')[1];
    assert.ok(row.startsWith('"a,b ""c""",'), row);
  });

  it('renders missing metadata as empty cells rather than "undefined"', () => {
    const csv = buildCatalogCsv([
      dataset({ axes: undefined, shape: undefined, dtype: undefined, scaleCount: undefined, omeZarrVersion: undefined }),
    ]);
    const row = csv.trimEnd().split('\n')[1];
    assert.doesNotMatch(row, /undefined/);
    assert.ok(row.includes(',unknown,'), row);
  });

  it('configures Zarrcade to read the column the catalog actually writes', () => {
    const config = buildZarrcadeConfig('https://example.test/portal/_session/s1/catalog.csv', 'T') as {
      dataUrl: string;
      data: { pathColumn: string };
      display: { hideColumns: string[]; titleColumn: string };
    };
    const header = buildCatalogCsv([dataset()]).split('\n')[0].split(',');

    assert.ok(header.includes(config.data.pathColumn));
    assert.ok(header.includes(config.display.titleColumn));
    for (const hidden of config.display.hideColumns) assert.ok(header.includes(hidden));
    assert.equal(config.dataUrl, 'https://example.test/portal/_session/s1/catalog.csv');
  });

  it('offers only viewers that can reach a local URL', () => {
    const config = buildZarrcadeConfig('catalog.csv', 'T') as {
      viewers: Array<{ name: string; urlTemplate: string; enabled: boolean }>;
    };
    for (const viewer of config.viewers.filter((v) => v.enabled)) {
      assert.ok(
        viewer.urlTemplate.startsWith('https://example.test/portal/'),
        `${viewer.name} points off-origin: ${viewer.urlTemplate}`,
      );
    }
  });

  it('produces a template Zarrcade can substitute into a working viewer URL', () => {
    // The end-to-end contract: Zarrcade fills in the template with a row's
    // path, and the result must be a Neuroglancer URL for that exact source.
    const url = zarrcadeViewerUrl(neuroglancerUrlTemplate(), dataset().virtualUrl);

    assert.ok(url.startsWith('https://example.test/portal/neuroglancer/index.html#!'), url);
    const state = JSON.parse(url.slice(url.indexOf('#!') + 2));
    assert.equal(
      state.layers[0].source,
      'zarr://https://example.test/portal/_local/m1/img.ome.zarr/',
    );
    assert.equal(state.layers[0].name, 'img.ome');
    assert.equal(state.selectedLayer.layer, state.layers[0].name);
  });
});
