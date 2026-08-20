/**
 * Page-side helpers, injected into the browser as strings.
 *
 * These build an OME-Zarr image in OPFS and register it as a mount. OPFS
 * handles are ordinary `FileSystemDirectoryHandle`s — same interface, same
 * structured-clone behaviour — so this exercises the real serving path
 * without needing a human to drag a folder in.
 */

export const pageHelpers = `
async function writeFile(dir, path, contents) {
  const parts = path.split('/');
  let current = dir;
  for (const part of parts.slice(0, -1)) {
    current = await current.getDirectoryHandle(part, { create: true });
  }
  const handle = await current.getFileHandle(parts[parts.length - 1], { create: true });
  const writable = await handle.createWritable();
  await writable.write(contents); 
  await writable.close();
}

async function buildOmeZarrV3(root, name) {
  const dir = await root.getDirectoryHandle(name, { create: true });
  await writeFile(dir, 'zarr.json', JSON.stringify({
    zarr_format: 3,
    node_type: 'group',
    attributes: {
      ome: {
        version: '0.5',
        multiscales: [{
          name: 'browser test',
          axes: [
            { name: 'z', type: 'space', unit: 'micrometer' },
            { name: 'y', type: 'space', unit: 'micrometer' },
            { name: 'x', type: 'space', unit: 'micrometer' },
          ],
          datasets: [{ path: '0', coordinateTransformations: [{ type: 'scale', scale: [1, 1, 1] }] }],
        }],
      },
    },
  }));
  await writeFile(dir, '0/zarr.json', JSON.stringify({
    zarr_format: 3,
    node_type: 'array',
    shape: [4, 16, 16],
    data_type: 'uint8',
    chunk_grid: { name: 'regular', configuration: { chunk_shape: [4, 16, 16] } },
    chunk_key_encoding: { name: 'default', configuration: { separator: '/' } },
    codecs: [{ name: 'bytes', configuration: { endian: 'little' } }],
    fill_value: 0,
  }));
  // One chunk covering the whole array, with a recognisable ramp.
  const voxels = new Uint8Array(4 * 16 * 16);
  for (let i = 0; i < voxels.length; i++) voxels[i] = i % 251;
  await writeFile(dir, '0/c/0/0/0', voxels);
  return dir;
}

/** A 2-D image: channel, y, x — no z axis at all. */
async function buildOmeZarrV3Planar(root, name) {
  const dir = await root.getDirectoryHandle(name, { create: true });
  await writeFile(dir, 'zarr.json', JSON.stringify({
    zarr_format: 3,
    node_type: 'group',
    attributes: {
      ome: {
        version: '0.5',
        multiscales: [{
          name: 'planar test',
          axes: [
            { name: 'c', type: 'channel' },
            { name: 'y', type: 'space', unit: 'micrometer' },
            { name: 'x', type: 'space', unit: 'micrometer' },
          ],
          datasets: [{ path: '0', coordinateTransformations: [{ type: 'scale', scale: [1, 1, 1] }] }],
        }],
      },
    },
  }));
  await writeFile(dir, '0/zarr.json', JSON.stringify({
    zarr_format: 3,
    node_type: 'array',
    shape: [1, 16, 16],
    data_type: 'uint8',
    chunk_grid: { name: 'regular', configuration: { chunk_shape: [1, 16, 16] } },
    chunk_key_encoding: { name: 'default', configuration: { separator: '/' } },
    codecs: [{ name: 'bytes', configuration: { endian: 'little' } }],
    fill_value: 0,
  }));
  const voxels = new Uint8Array(16 * 16);
  for (let i = 0; i < voxels.length; i++) voxels[i] = i % 251;
  await writeFile(dir, '0/c/0/0/0', voxels);
  return dir;
}

/**
 * A 5-D image: two timepoints, three channels, two z slices.
 *
 * Built so the preview rules are visible in the pixels. Timepoint 1 is
 * saturated everywhere, so a preview that read the wrong timepoint — or
 * projected across time — would come out flat. Within timepoint 0 the three
 * channels vary along different axes: channel 0 ramps horizontally, channel 1
 * is constant, and channel 2 ramps vertically. Once they are tinted and
 * overlaid, each channel's contribution is separable in the result.
 */
async function buildOmeZarrV3Series(root, name) {
  const dir = await root.getDirectoryHandle(name, { create: true });
  await writeFile(dir, 'zarr.json', JSON.stringify({
    zarr_format: 3,
    node_type: 'group',
    attributes: {
      ome: {
        version: '0.5',
        multiscales: [{
          name: 'series test',
          axes: [
            { name: 't', type: 'time' },
            { name: 'c', type: 'channel' },
            { name: 'z', type: 'space', unit: 'micrometer' },
            { name: 'y', type: 'space', unit: 'micrometer' },
            { name: 'x', type: 'space', unit: 'micrometer' },
          ],
          datasets: [{ path: '0', coordinateTransformations: [{ type: 'scale', scale: [1, 1, 1, 1, 1] }] }],
        }],
      },
    },
  }));
  await writeFile(dir, '0/zarr.json', JSON.stringify({
    zarr_format: 3,
    node_type: 'array',
    shape: [2, 3, 2, 16, 16],
    data_type: 'uint8',
    chunk_grid: { name: 'regular', configuration: { chunk_shape: [2, 3, 2, 16, 16] } },
    chunk_key_encoding: { name: 'default', configuration: { separator: '/' } },
    codecs: [{ name: 'bytes', configuration: { endian: 'little' } }],
    fill_value: 0,
  }));

  const voxels = new Uint8Array(2 * 3 * 2 * 16 * 16);
  const at = (t, c, z, y, x) => ((((t * 3 + c) * 2 + z) * 16 + y) * 16) + x;
  for (let c = 0; c < 3; c++) {
    for (let z = 0; z < 2; z++) {
      for (let y = 0; y < 16; y++) {
        for (let x = 0; x < 16; x++) {
          // z = 0 is empty, so the z projection has to reach the second slice.
          const value = z === 0 ? 0 : c === 0 ? x * 16 : c === 1 ? 7 : y * 16;
          voxels[at(0, c, z, y, x)] = value;
          voxels[at(1, c, z, y, x)] = 255;
        }
      }
    }
  }
  await writeFile(dir, '0/c/0/0/0/0/0', voxels);
  return dir;
}

/**
 * An OME-Zarr v4 image whose single chunk is blosc-compressed.
 *
 * This is the layout most OME-Zarr in the wild actually uses, and it is the
 * only fixture that exercises a real compression codec — the v3 ones store raw
 * bytes, which would let a broken codec path pass unnoticed.
 */
async function buildOmeZarrV2Blosc(root, name, chunkBase64) {
  const dir = await root.getDirectoryHandle(name, { create: true });
  await writeFile(dir, '.zgroup', JSON.stringify({ zarr_format: 2 }));
  await writeFile(dir, '.zattrs', JSON.stringify({
    multiscales: [{
      version: '0.4',
      name: 'blosc test',
      axes: [
        { name: 'z', type: 'space' },
        { name: 'y', type: 'space' },
        { name: 'x', type: 'space' },
      ],
      datasets: [{ path: '0', coordinateTransformations: [{ type: 'scale', scale: [1, 1, 1] }] }],
    }],
  }));
  await writeFile(dir, '0/.zarray', JSON.stringify({
    zarr_format: 2,
    shape: [4, 16, 16],
    chunks: [4, 16, 16],
    dtype: '|u1',
    compressor: { id: 'blosc', cname: 'zstd', clevel: 5, shuffle: 1, blocksize: 0 },
    fill_value: 0,
    order: 'C',
    filters: null,
  }));
  const bytes = Uint8Array.from(atob(chunkBase64), (c) => c.charCodeAt(0));
  // The v4 layout separates chunk indices with '.', so the key is flat.
  await writeFile(dir, '0/0.0.0', bytes);
  return dir;
}

function openPortalDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('ome-zarr-portal', 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('mounts')) db.createObjectStore('mounts', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('sessionFiles')) {
        const store = db.createObjectStore('sessionFiles', { keyPath: 'key' });
        store.createIndex('sessionId', 'sessionId', { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function idbPut(store, value) {
  const db = await openPortalDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(value);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

/** Create an OPFS-backed mount and return its id. */
async function createOpfsMount(mountId, folderName, imageName, bloscChunkBase64) {
  const opfs = await navigator.storage.getDirectory();
  // Start clean so repeated runs do not accumulate.
  try { await opfs.removeEntry(folderName, { recursive: true }); } catch {}
  const folder = await opfs.getDirectoryHandle(folderName, { create: true });
  await buildOmeZarrV3(folder, imageName);
  await buildOmeZarrV3Planar(folder, 'planar_test.ome.zarr');
  await buildOmeZarrV3Series(folder, 'series_test.ome.zarr');
  if (bloscChunkBase64) {
    await buildOmeZarrV2Blosc(folder, 'blosc_test.ome.zarr', bloscChunkBase64);
  }
  await idbPut('mounts', { id: mountId, name: folderName, handle: folder, createdAt: Date.now() });
  return mountId;
}
`;
