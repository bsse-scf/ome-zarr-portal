/**
 * Contract shared by the page and the service worker.
 *
 * Both sides run in the same origin but in different JS realms, so everything
 * they agree on — IndexedDB names, URL prefixes, message shapes — lives here.
 */

/**
 * Virtual namespace segments, appended to the deployment base path.
 *
 * The base is not a constant: the portal is built with a relative base so the
 * same bundle runs at an origin root and at a GitHub Pages project subpath
 * (`/<repo>/`). A service worker can only claim a scope at or below its own
 * path, so at `/<repo>/` the namespace is `/<repo>/_local/...`. Both sides
 * derive the base at runtime — the worker from its registration scope, the
 * page from the same scope once registered — and join these segments onto it.
 */
export const LOCAL_SEGMENT = '_local';
export const SESSION_SEGMENT = '_session';
/**
 * Derived preview images, rendered on demand from a dataset's coarsest
 * pyramid level. Kept out of `_local/`, which is a faithful mirror of what is
 * actually on disk.
 */
export const PREVIEW_SEGMENT = '_preview';

/** Join a base path (with trailing slash) and a namespace segment. */
export function namespacePrefix(basePath: string, segment: string): string {
  return `${basePath}${segment}/`;
}

export const DB_NAME = 'ome-zarr-portal';
export const DB_VERSION = 1;
export const MOUNT_STORE = 'mounts';
export const SESSION_STORE = 'sessionFiles';

/**
 * A mounted local directory.
 *
 * `handle` is a live `FileSystemDirectoryHandle`. Both IndexedDB and
 * `postMessage` can carry these by structured clone, which is what lets the
 * service worker read the user's files directly instead of proxying every
 * byte through the page.
 */
export interface MountRecord {
  id: string;
  name: string;
  handle: FileSystemDirectoryHandle;
  createdAt: number;
}

/** A generated document served under the `_session/` namespace. */
export interface SessionFileRecord {
  /** `${sessionId}/${path}` — the IndexedDB key. */
  key: string;
  sessionId: string;
  path: string;
  body: string;
  contentType: string;
  createdAt: number;
}

/** Messages the page sends to the service worker. */
export type PortalMessage =
  | { type: 'ping' }
  | { type: 'flush'; mountId?: string };

/** Bumped when the worker's behaviour changes, for debugging. */
export const SW_VERSION = '1';
