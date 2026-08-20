import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// `siteUrl` derives the deployment base from `location`, which Node lacks.
// Point it at a subpath deployment so the tests also cover the GitHub Pages
// case, where nothing may assume the site lives at the origin root.
(globalThis as unknown as { location: URL }).location = new URL('https://example.test/portal/');

import type { DiscoveredImage } from '../src/discovery/types';
import {
  buildNeuroglancerState,
  chooseLayout,
  isVolumetric,
  neuroglancerUrl,
  neuroglancerUrlTemplate,
} from '../src/integrations/neuroglancer';
import { buildCatalogCsv, buildZarrcadeConfig } from '../src/integrations/zarrcade';

function image(overrides: Partial<DiscoveredImage> = {}): DiscoveredImage {
  return {
    id: 'm1:img.ome.zarr',
    name: 'img',
    relativePath: 'img.ome.zarr',
    virtualUrl: 'https://example.test/portal/_local/m1/img.ome.zarr/',
    omeZarrVersion: '0.4',
    mountId: 'm1',
    mountName: 'drop',
    layout: 'v4',
    axes: ['c', 'y', 'x'],
    shape: [2, 64, 64],
    dtype: '<u2',
    levelCount: 3,
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
  it('makes one auto-typed zarr layer per image', () => {
    const state = buildNeuroglancerState([image(), image({ name: 'other', id: 'm1:other' })]);
    assert.equal(state.layers.length, 2);
    assert.equal(state.layers[0].type, 'auto');
    assert.equal(
      state.layers[0].source,
      'zarr://https://example.test/portal/_local/m1/img.ome.zarr/',
    );
    // Selected, but with its side panel closed: the viewer opens on the image
    // rather than on a panel of shader controls.
    assert.deepEqual(state.selectedLayer, { visible: false, layer: 'img' });
  });

  it('disambiguates layers that share a folder name', () => {
    const state = buildNeuroglancerState([
      image(),
      image({ id: 'm2:img.ome.zarr', virtualUrl: 'https://example.test/portal/_local/m2/img.ome.zarr/' }),
      image({ id: 'm3:img.ome.zarr', virtualUrl: 'https://example.test/portal/_local/m3/img.ome.zarr/' }),
    ]);
    assert.deepEqual(
      state.layers.map((layer) => layer.name),
      ['img', 'img (2)', 'img (3)'],
    );
  });

  it('points at the bundled viewer, not a public instance', () => {
    const url = neuroglancerUrl([image()]);
    assert.ok(url.startsWith('https://example.test/portal/neuroglancer/index.html#!'), url);

    const state = JSON.parse(decodeURIComponent(url.slice(url.indexOf('#!') + 2)));
    assert.equal(state.layers[0].source, 'zarr://https://example.test/portal/_local/m1/img.ome.zarr/');
  });

  it('survives an empty image list without a dangling selection', () => {
    const state = buildNeuroglancerState([]);
    assert.deepEqual(state.layers, []);
    assert.equal(state.selectedLayer, undefined);
  });
});

describe('viewer layout', () => {
  const planar = (overrides: Partial<DiscoveredImage> = {}) =>
    image({ axes: ['c', 'y', 'x'], shape: [2, 64, 64], ...overrides });
  const volumetric = (overrides: Partial<DiscoveredImage> = {}) =>
    image({ axes: ['z', 'y', 'x'], shape: [32, 64, 64], ...overrides });

  it('uses a single xy panel when there is no z axis', () => {
    assert.equal(isVolumetric(planar()), false);
    assert.equal(chooseLayout([planar()]), 'xy');
    assert.equal(buildNeuroglancerState([planar()]).layout, 'xy');
  });

  it('uses orthogonal panels when a z axis is present', () => {
    assert.equal(isVolumetric(volumetric()), true);
    assert.equal(chooseLayout([volumetric()]), '4panel-alt');
    assert.equal(buildNeuroglancerState([volumetric()]).layout, '4panel-alt');
  });

  it('treats a singleton z axis as planar', () => {
    // A 2-D image stored as 5-D, which orthogonal panels would render as two
    // degenerate single-voxel strips.
    const flat = image({ axes: ['t', 'c', 'z', 'y', 'x'], shape: [1, 3, 1, 512, 512] });
    assert.equal(isVolumetric(flat), false);
    assert.equal(chooseLayout([flat]), 'xy');
  });

  it('keeps orthogonal panels when any image in the set has depth', () => {
    // The layout belongs to the viewer, not the layer, so a mixed set has to
    // pick the one that still displays planar layers correctly.
    assert.equal(chooseLayout([planar(), volumetric()]), '4panel-alt');
  });

  it('assumes depth when axes metadata is absent', () => {
    // OME-Zarr before 0.4 declares no axes and was always 5-D.
    const legacy = image({ axes: undefined, shape: undefined, omeZarrVersion: '0.3' });
    assert.equal(isVolumetric(legacy), true);
    assert.equal(chooseLayout([legacy]), '4panel-alt');
  });

  it('ignores a shape that does not line up with the axes', () => {
    const mismatched = image({ axes: ['z', 'y', 'x'], shape: [64, 64] });
    assert.equal(isVolumetric(mismatched), true);
  });

  it('matches a capitalised axis name', () => {
    assert.equal(isVolumetric(image({ axes: ['Z', 'Y', 'X'], shape: [8, 8, 8] })), true);
  });

  it('carries the chosen layout into the Zarrcade viewer template', () => {
    const url = zarrcadeViewerUrl(neuroglancerUrlTemplate([planar()]), planar().virtualUrl);
    assert.equal(JSON.parse(url.slice(url.indexOf('#!') + 2)).layout, 'xy');

    const volumetricUrl = zarrcadeViewerUrl(
      neuroglancerUrlTemplate([volumetric()]),
      volumetric().virtualUrl,
    );
    assert.equal(JSON.parse(volumetricUrl.slice(volumetricUrl.indexOf('#!') + 2)).layout, '4panel-alt');
  });
});

describe('gallery previews', () => {
  const cell = (overrides: Partial<DiscoveredImage>) => {
    const row = buildCatalogCsv([image(overrides)]).trimEnd().split('\n')[1];
    return row.split(',')[2];
  };

  it('links a generated preview when the image has no thumbnail of its own', () => {
    assert.equal(
      cell({ previewable: true, hasConventionThumbnail: false }),
      'https://example.test/portal/_preview/m1/img.ome.zarr',
    );
  });

  it('stands aside when the image ships its own thumbnails', () => {
    // Left empty on purpose: Zarrcade then reads the zarr thumbnails
    // convention itself and picks the best-sized entry.
    assert.equal(cell({ previewable: false, hasConventionThumbnail: true }), '');
  });

  it('prefers a real thumbnail over a projection when both are possible', () => {
    assert.equal(cell({ previewable: true, hasConventionThumbnail: true }), '');
  });

  it('leaves the cell empty when no preview can be produced', () => {
    // Zarrcade falls through to its placeholder icon.
    assert.equal(cell({ previewable: false, hasConventionThumbnail: false }), '');
  });

  it('tells Zarrcade which column holds the thumbnail, and hides it', () => {
    const config = buildZarrcadeConfig('catalog.csv', 'T', [image()]) as {
      data: { thumbnailColumn: string };
      display: { hideColumns: string[] };
    };
    const header = buildCatalogCsv([image()]).split('\n')[0].split(',');

    assert.ok(header.includes(config.data.thumbnailColumn), 'column exists in the catalog');
    assert.ok(
      config.display.hideColumns.includes(config.data.thumbnailColumn),
      'the URL is not shown as metadata',
    );
  });
});

describe('Zarrcade catalog', () => {
  it('emits a header and one row per image', () => {
    const csv = buildCatalogCsv([image(), image({ name: 'second', id: 'm1:second' })]);
    const lines = csv.trimEnd().split('\n');
    assert.equal(lines.length, 3);
    assert.equal(
      lines[0],
      'Name,path,thumbnail,Folder,Location,OME-Zarr Version,Axes,Shape,Data Type,Resolution Levels',
    );
    assert.ok(lines[1].startsWith('img,https://example.test/portal/_local/m1/img.ome.zarr/,'));
  });

  it('quotes fields containing commas or quotes', () => {
    const csv = buildCatalogCsv([image({ name: 'a,b "c"' })]);
    const row = csv.trimEnd().split('\n')[1];
    assert.ok(row.startsWith('"a,b ""c""",'), row);
  });

  it('renders missing metadata as empty cells rather than "undefined"', () => {
    const csv = buildCatalogCsv([
      image({ axes: undefined, shape: undefined, dtype: undefined, levelCount: undefined, omeZarrVersion: undefined }),
    ]);
    const row = csv.trimEnd().split('\n')[1];
    assert.doesNotMatch(row, /undefined/);
    // Undeclared version: the layout on disk still rules out v5.
    assert.ok(row.includes(',v4 or earlier,'), row);
  });

  it('configures Zarrcade to read the column the catalog actually writes', () => {
    const config = buildZarrcadeConfig(
      'https://example.test/portal/_session/s1/catalog.csv',
      'T',
      [image()],
    ) as {
      dataUrl: string;
      data: { pathColumn: string };
      display: { hideColumns: string[]; titleColumn: string };
    };
    const header = buildCatalogCsv([image()]).split('\n')[0].split(',');

    assert.ok(header.includes(config.data.pathColumn));
    assert.ok(header.includes(config.display.titleColumn));
    for (const hidden of config.display.hideColumns) assert.ok(header.includes(hidden));
    assert.equal(config.dataUrl, 'https://example.test/portal/_session/s1/catalog.csv');
  });

  it('offers only viewers that can reach a local URL', () => {
    const config = buildZarrcadeConfig('catalog.csv', 'T', [image()]) as {
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
    const url = zarrcadeViewerUrl(neuroglancerUrlTemplate([image()]), image().virtualUrl);

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
