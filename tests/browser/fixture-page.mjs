/**
 * Page-side helpers, injected into the browser as strings.
 *
 * These build an OME-Zarr dataset in OPFS and register it as a mount. OPFS
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
async function createOpfsMount(mountId, folderName, datasetName) {
  const opfs = await navigator.storage.getDirectory();
  // Start clean so repeated runs do not accumulate.
  try { await opfs.removeEntry(folderName, { recursive: true }); } catch {}
  const folder = await opfs.getDirectoryHandle(folderName, { create: true });
  await buildOmeZarrV3(folder, datasetName);
  await buildOmeZarrV3Planar(folder, 'planar_test.ome.zarr');
  await idbPut('mounts', { id: mountId, name: folderName, handle: folder, createdAt: Date.now() });
  return mountId;
}
`;
