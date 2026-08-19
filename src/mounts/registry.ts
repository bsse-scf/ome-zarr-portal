/**
 * Filesystem mounting.
 *
 * A "mount" is a dropped directory exposed read-only under a random id. The
 * handle is stored in IndexedDB because the service worker — not the page —
 * is what ultimately reads the bytes, and the worker can be restarted by the
 * browser at any time.
 */
import { idbDelete, idbGetAll, idbPut } from '../vfs/idb';
import { MOUNT_STORE, type MountRecord } from '../vfs/protocol';
import { flushWorker, localUrl } from '../vfs/client';

export type Mount = MountRecord;

/**
 * Short, URL-safe, unguessable id. Unguessable matters a little: it is the
 * only thing separating one mount's namespace from another's within the
 * origin, and it keeps ids from colliding across sessions.
 */
function newMountId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function createMount(handle: FileSystemDirectoryHandle): Promise<Mount> {
  const mount: Mount = {
    id: newMountId(),
    name: handle.name,
    handle,
    createdAt: Date.now(),
  };
  await idbPut(MOUNT_STORE, mount);
  return mount;
}

export async function listMounts(): Promise<Mount[]> {
  const mounts = await idbGetAll<Mount>(MOUNT_STORE);
  return mounts.sort((a, b) => a.createdAt - b.createdAt);
}

export async function removeMount(mountId: string): Promise<void> {
  await idbDelete(MOUNT_STORE, mountId);
  await flushWorker(mountId);
}

export async function removeAllMounts(): Promise<void> {
  const mounts = await listMounts();
  await Promise.all(mounts.map((mount) => idbDelete(MOUNT_STORE, mount.id)));
  await flushWorker();
}

/**
 * Drop mounts whose read permission no longer holds.
 *
 * Handles survive a reload in IndexedDB but their permission grant does not:
 * re-granting requires a user gesture. Rather than leave the user with mounts
 * that 403 on every request, forget them so the UI can ask for a fresh drop.
 * Returns the number removed.
 */
export async function pruneUnreadableMounts(): Promise<number> {
  const mounts = await listMounts();
  let removed = 0;
  for (const mount of mounts) {
    let state: PermissionState = 'granted';
    try {
      state = await mount.handle.queryPermission({ mode: 'read' });
    } catch {
      state = 'denied';
    }
    if (state !== 'granted') {
      await idbDelete(MOUNT_STORE, mount.id);
      removed += 1;
    }
  }
  if (removed > 0) await flushWorker();
  return removed;
}

/** Root URL of a mount, always with a trailing slash. */
export function mountRootUrl(mountId: string): string {
  return localUrl(mountId);
}
