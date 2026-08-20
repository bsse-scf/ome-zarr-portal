/**
 * Dedicated worker that renders image previews.
 *
 * Lives here rather than in the service worker for two reasons: a service
 * worker cannot use dynamic `import()`, so zarrita's WASM codecs would have to
 * be bundled in eagerly, and measurements showed that doing so slowed the
 * `_local/` request path Neuroglancer relies on. Here the codecs load on first
 * use and cost nothing until a gallery is opened.
 *
 * It reads mounts from IndexedDB itself, so it needs nothing from the page but
 * a mount id and a path.
 */
import { idbGet } from '../vfs/idb';
import { MOUNT_STORE, type MountRecord } from '../vfs/protocol';
import { renderPreview } from './render';

export interface RenderRequest {
  id: number;
  mountId: string;
  relativePath: string;
}

export type RenderReply =
  | { id: number; ok: true; png: ArrayBuffer }
  | { id: number; ok: false; error: string };

const worker = self as unknown as DedicatedWorkerGlobalScope;

worker.addEventListener('message', (event: MessageEvent<RenderRequest>) => {
  const request = event.data;
  void (async () => {
    try {
      const mount = await idbGet<MountRecord>(MOUNT_STORE, request.mountId);
      if (!mount) throw new Error(`Unknown mount ${request.mountId}`);

      const png = await renderPreview(mount.handle, request.relativePath);
      const buffer = await png.arrayBuffer();
      const reply: RenderReply = { id: request.id, ok: true, png: buffer };
      // Transfer rather than copy: previews are hundreds of kilobytes.
      worker.postMessage(reply, [buffer]);
    } catch (error) {
      const reply: RenderReply = {
        id: request.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
      worker.postMessage(reply);
    }
  })();
});
