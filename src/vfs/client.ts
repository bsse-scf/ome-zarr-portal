/**
 * Page-side half of the virtual filesystem: registers the service worker and
 * writes the records it reads.
 */
import { idbDelete, idbGetAll, idbPut } from './idb';
import {
  LOCAL_SEGMENT,
  namespacePrefix,
  PREVIEW_SEGMENT,
  SESSION_SEGMENT,
  SESSION_STORE,
  type PortalMessage,
  type SessionFileRecord,
} from './protocol';

export class ServiceWorkerUnavailableError extends Error {}

let registration: Promise<ServiceWorkerRegistration> | null = null;
let basePath: string | null = null;

/**
 * The path the portal is deployed under, always with a trailing slash — `/`
 * locally, `/<repo>/` on a GitHub Pages project site.
 *
 * Once the worker is registered this is its scope, which is authoritative:
 * URLs built from any other value would not be intercepted. Before that, fall
 * back to the landing page's own directory, which is the same thing.
 */
export function getBasePath(): string {
  return basePath ?? new URL('./', location.href).pathname;
}

/**
 * Register the worker and resolve once it actually controls this page.
 *
 * Controlling matters: an uncontrolled page's `/_local/` requests would fall
 * through to the network and 404. The worker calls `clients.claim()` on
 * activation, so a first-visit page becomes controlled without a reload.
 */
export function ensureServiceWorker(): Promise<ServiceWorkerRegistration> {
  if (registration) return registration;

  registration = (async () => {
    if (!('serviceWorker' in navigator)) {
      throw new ServiceWorkerUnavailableError(
        'This browser has no Service Worker support, which the portal needs to expose local files.',
      );
    }
    if (!window.isSecureContext) {
      throw new ServiceWorkerUnavailableError(
        'Service Workers require a secure context. Use http://localhost or an https:// origin.',
      );
    }

    // Registered relative to this page, which lives at the deployment root.
    // That resolves to `/sw.js` locally and `/<repo>/sw.js` on GitHub Pages,
    // and the default scope is the worker's own directory in both cases — so
    // no build-time knowledge of the deployment path is needed. In dev, a Vite
    // middleware serves the transformed worker at the same URL.
    const reg = await navigator.serviceWorker.register(
      new URL('./sw.js', new URL('./', location.href)),
      { type: 'module' },
    );
    basePath = new URL(reg.scope).pathname;
    await navigator.serviceWorker.ready;

    if (!navigator.serviceWorker.controller) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 3000);
        navigator.serviceWorker.addEventListener(
          'controllerchange',
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });
    }
    return reg;
  })();

  registration.catch(() => {
    // Allow a later retry rather than caching the failure forever.
    registration = null;
  });

  return registration;
}

/** Tell the worker to forget cached handles for a mount (or all of them). */
export async function flushWorker(mountId?: string): Promise<void> {
  const controller = navigator.serviceWorker?.controller;
  if (!controller) return;
  const message: PortalMessage = { type: 'flush', mountId };
  controller.postMessage(message);
}

function encodePath(path: string): string {
  return path.split('/').filter(Boolean).map(encodeURIComponent).join('/');
}

/**
 * Absolute URL for a path inside a mount, e.g.
 * `https://host/_local/ab12/sample.ome.zarr/0/c/0/0/0`.
 *
 * Segments are encoded individually so that spaces and other characters that
 * are legal in file names survive the round trip, while `/` keeps its meaning
 * as a separator. With no relative path this returns the mount root, with a
 * trailing slash — the form Zarr sources expect.
 */
export function localUrl(mountId: string, relativePath = ''): string {
  const prefix = namespacePrefix(getBasePath(), LOCAL_SEGMENT);
  return new URL(
    `${prefix}${encodeURIComponent(mountId)}/${encodePath(relativePath)}`,
    location.origin,
  ).href;
}

/**
 * Absolute URL of an image's generated preview image.
 *
 * Deliberately outside `_local/`, which mirrors what is actually on disk;
 * a preview is derived, not a file the user has.
 */
export function previewUrl(mountId: string, relativePath: string): string {
  const prefix = namespacePrefix(getBasePath(), PREVIEW_SEGMENT);
  return new URL(
    `${prefix}${encodeURIComponent(mountId)}/${encodePath(relativePath)}`,
    location.origin,
  ).href;
}

/** Absolute URL for a portal-generated document. */
export function sessionUrl(sessionId: string, path: string): string {
  const prefix = namespacePrefix(getBasePath(), SESSION_SEGMENT);
  return new URL(
    `${prefix}${encodeURIComponent(sessionId)}/${encodePath(path)}`,
    location.origin,
  ).href;
}

/** Absolute URL for a page shipped alongside the portal, e.g. `zarrcade/`. */
export function siteUrl(relativePath: string): string {
  return new URL(`${getBasePath()}${relativePath}`, location.origin).href;
}

export async function putSessionFile(
  sessionId: string,
  path: string,
  body: string,
  contentType: string,
): Promise<string> {
  const record: SessionFileRecord = {
    key: `${sessionId}/${path}`,
    sessionId,
    path,
    body,
    contentType,
    createdAt: Date.now(),
  };
  await idbPut(SESSION_STORE, record);
  return sessionUrl(sessionId, path);
}

/**
 * Drop generated documents from older sessions.
 *
 * They are tiny, but they reference mounts that may be gone, so keeping them
 * around only creates confusing dead links in the browser history.
 */
export async function pruneSessions(keepSessionId?: string): Promise<void> {
  const all = await idbGetAll<SessionFileRecord>(SESSION_STORE);
  await Promise.all(
    all
      .filter((record) => record.sessionId !== keepSessionId)
      .map((record) => idbDelete(SESSION_STORE, record.key)),
  );
}
