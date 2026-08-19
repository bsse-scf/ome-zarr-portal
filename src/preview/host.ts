/**
 * Page-side preview host.
 *
 * The service worker cannot render previews itself (see `worker.ts`), so it
 * asks a controlled page to do it. This module answers those requests, fans
 * them out to a small pool of dedicated workers, and returns PNG bytes.
 *
 * Installing this is what makes previews available. A gallery opened with no
 * portal page anywhere loses them and falls back to Zarrcade's placeholder
 * icon — deliberately, rather than blocking.
 */
import type { RenderReply, RenderRequest } from './worker';

/**
 * Two workers: enough to keep previews arriving while one is busy with a
 * larger dataset, few enough that a page of 50 gallery cards cannot spike
 * memory by decompressing dozens of pyramid levels at once.
 */
const POOL_SIZE = 2;

interface Pending {
  resolve: (png: ArrayBuffer) => void;
  reject: (error: Error) => void;
}

class RenderPool {
  private readonly workers: Worker[] = [];
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private nextWorker = 0;

  /** Workers are created on first use, so the cost is paid only if a gallery is opened. */
  private ensureWorkers(): Worker[] {
    if (this.workers.length > 0) return this.workers;

    for (let index = 0; index < POOL_SIZE; index += 1) {
      const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
      worker.addEventListener('message', (event: MessageEvent<RenderReply>) => {
        const reply = event.data;
        const waiting = this.pending.get(reply.id);
        if (!waiting) return;
        this.pending.delete(reply.id);
        if (reply.ok) waiting.resolve(reply.png);
        else waiting.reject(new Error(reply.error));
      });
      worker.addEventListener('error', (event) => {
        // A worker that failed to start would otherwise leave every request
        // hanging until the service worker's timeout.
        for (const [id, waiting] of this.pending) {
          this.pending.delete(id);
          waiting.reject(new Error(event.message || 'Preview worker failed'));
        }
      });
      this.workers.push(worker);
    }
    return this.workers;
  }

  render(mountId: string, relativePath: string): Promise<ArrayBuffer> {
    const workers = this.ensureWorkers();
    const id = this.nextId++;
    // Round-robin. Each worker processes its queue in order, which is what
    // bounds concurrency — no separate semaphore needed.
    const worker = workers[this.nextWorker++ % workers.length];

    return new Promise<ArrayBuffer>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const request: RenderRequest = { id, mountId, relativePath };
      worker.postMessage(request);
    });
  }
}

let pool: RenderPool | null = null;
let installed = false;

/**
 * Start answering the service worker's render requests.
 *
 * Safe to call more than once; only the first call registers a listener.
 */
export function installPreviewHost(): void {
  if (installed || !('serviceWorker' in navigator)) return;
  installed = true;

  navigator.serviceWorker.addEventListener('message', (event: MessageEvent) => {
    const data = event.data as { type?: string; mountId?: string; relativePath?: string };
    if (data?.type !== 'render-preview') return;

    const port = event.ports[0];
    if (!port || !data.mountId) return;

    pool ??= new RenderPool();
    pool
      .render(data.mountId, data.relativePath ?? '')
      .then((png) => port.postMessage({ ok: true, png }, [png]))
      .catch((error: Error) => port.postMessage({ ok: false, error: error.message }));
  });
}
