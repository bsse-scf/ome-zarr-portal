/**
 * Builds an on-disk tree exercising the layouts discovery has to tell apart:
 * Zarr v2 and v3 multiscales, resolution levels that must NOT be mistaken for
 * datasets, a bare array, an HCS plate, and assorted noise.
 */
import { promises as fs } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function writeJson(path: string, value: unknown): Promise<void> {
  await fs.mkdir(join(path, '..'), { recursive: true });
  await fs.writeFile(path, JSON.stringify(value, null, 2));
}

/** A v2 multiscale image with two resolution levels and real chunk files. */
async function makeV2Image(root: string, levels = 2): Promise<void> {
  await writeJson(join(root, '.zgroup'), { zarr_format: 2 });
  await writeJson(join(root, '.zattrs'), {
    multiscales: [
      {
        version: '0.4',
        name: 'example',
        axes: [
          { name: 'c', type: 'channel' },
          { name: 'y', type: 'space', unit: 'micrometer' },
          { name: 'x', type: 'space', unit: 'micrometer' },
        ],
        datasets: Array.from({ length: levels }, (_, index) => ({
          path: String(index),
          coordinateTransformations: [{ type: 'scale', scale: [1, 2 ** index, 2 ** index] }],
        })),
      },
    ],
  });

  for (let level = 0; level < levels; level += 1) {
    const size = 64 >> level;
    await writeJson(join(root, String(level), '.zarray'), {
      zarr_format: 2,
      shape: [2, size, size],
      chunks: [1, size, size],
      dtype: '<u2',
      compressor: null,
      fill_value: 0,
      order: 'C',
      filters: null,
    });
    // Chunk keys use nested directories, the shape that must never be walked
    // into as if it were a dataset hierarchy.
    for (let channel = 0; channel < 2; channel += 1) {
      const chunkPath = join(root, String(level), String(channel), '0', '0');
      await fs.mkdir(join(chunkPath, '..'), { recursive: true });
      await fs.writeFile(chunkPath, Buffer.alloc(size * size * 2, level + 1));
    }
  }
}

/** A v3 multiscale image with OME metadata under `attributes.ome`. */
async function makeV3Image(root: string): Promise<void> {
  await writeJson(join(root, 'zarr.json'), {
    zarr_format: 3,
    node_type: 'group',
    attributes: {
      ome: {
        version: '0.5',
        multiscales: [
          {
            name: 'v3 example',
            axes: [
              { name: 'z', type: 'space' },
              { name: 'y', type: 'space' },
              { name: 'x', type: 'space' },
            ],
            datasets: [
              { path: '0', coordinateTransformations: [{ type: 'scale', scale: [1, 1, 1] }] },
            ],
          },
        ],
      },
    },
  });
  await writeJson(join(root, '0', 'zarr.json'), {
    zarr_format: 3,
    node_type: 'array',
    shape: [8, 32, 32],
    data_type: 'uint8',
    chunk_grid: { name: 'regular', configuration: { chunk_shape: [8, 32, 32] } },
    chunk_key_encoding: { name: 'default' },
    codecs: [{ name: 'bytes', configuration: { endian: 'little' } }],
    fill_value: 0,
  });
  const chunk = join(root, '0', 'c', '0', '0', '0');
  await fs.mkdir(join(chunk, '..'), { recursive: true });
  await fs.writeFile(chunk, Buffer.alloc(8 * 32 * 32, 7));
}

export interface Fixture {
  root: string;
  cleanup: () => Promise<void>;
}

export async function makeFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'ome-zarr-portal-'));

  // A dataset directly under the drop root.
  await makeV2Image(join(root, 'v2-image.ome.zarr'));

  // A dataset buried a few plain folders down.
  await makeV3Image(join(root, 'nested', 'deeper', 'v3-image.ome.zarr'));

  // A bare array: valid Zarr, but not an OME-Zarr image.
  await writeJson(join(root, 'bare-array.zarr', '.zarray'), {
    zarr_format: 2,
    shape: [4, 4],
    chunks: [4, 4],
    dtype: '<f4',
    compressor: null,
    fill_value: 0,
    order: 'C',
    filters: null,
  });

  // An HCS plate: not openable itself, but its fields of view are.
  const plate = join(root, 'plate.ome.zarr');
  await writeJson(join(plate, '.zgroup'), { zarr_format: 2 });
  await writeJson(join(plate, '.zattrs'), {
    plate: {
      version: '0.4',
      columns: [{ name: '1' }],
      rows: [{ name: 'A' }],
      wells: [{ path: 'A/1', rowIndex: 0, columnIndex: 0 }],
    },
  });
  await writeJson(join(plate, 'A', '1', '.zgroup'), { zarr_format: 2 });
  await writeJson(join(plate, 'A', '1', '.zattrs'), {
    well: { version: '0.4', images: [{ path: '0' }] },
  });
  await makeV2Image(join(plate, 'A', '1', '0'), 1);

  // Noise that must be ignored.
  await fs.writeFile(join(root, 'README.txt'), 'not a dataset');
  await fs.mkdir(join(root, '__MACOSX'), { recursive: true });
  await fs.mkdir(join(root, '.hidden'), { recursive: true });
  await fs.writeFile(join(root, '.hidden', 'secret'), 'ignored');

  return {
    root,
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  };
}
