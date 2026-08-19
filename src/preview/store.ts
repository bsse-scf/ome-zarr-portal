/**
 * A Zarr store that reads straight from a `FileSystemDirectoryHandle`.
 *
 * Zarrita's `Readable` contract is a single `get(key)`, so backing it with the
 * mounted handle is both trivial and better than pointing it at our own
 * `_local/` URLs: a service worker's own `fetch()` is not intercepted by that
 * same worker, and this skips the HTTP round trip entirely.
 */

/** Zarrita calls with absolute keys such as `/0/c/0/0/0`. */
type AbsolutePath = `/${string}`;

export class DirectoryHandleStore {
  constructor(private readonly root: FileSystemDirectoryHandle) {}

  async get(key: AbsolutePath): Promise<Uint8Array | undefined> {
    const segments = key.split('/').filter(Boolean);
    if (segments.length === 0) return undefined;

    try {
      let directory = this.root;
      for (const segment of segments.slice(0, -1)) {
        directory = await directory.getDirectoryHandle(segment);
      }
      const handle = await directory.getFileHandle(segments[segments.length - 1]);
      return new Uint8Array(await (await handle.getFile()).arrayBuffer());
    } catch {
      // A missing key is normal — zarrita probes for both v2 and v3 metadata,
      // and an absent chunk means "all fill value".
      return undefined;
    }
  }
}
