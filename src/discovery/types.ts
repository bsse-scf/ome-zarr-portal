/**
 * Types for the OME-Zarr discovery layer.
 */

/** A multiscale OME-Zarr image found inside a mounted directory. */
export interface DiscoveredDataset {
  /** Stable within a session: `<mount-id>:<relative-path>`. */
  id: string;
  /** Display name, from the directory name with `.ome.zarr`/`.zarr` stripped. */
  name: string;
  /** Path relative to the mount root; empty when the mount root is itself a dataset. */
  relativePath: string;
  /** Same-origin URL served by the worker, always with a trailing slash. */
  virtualUrl: string;
  /** OME-NGFF version string, e.g. `0.4` or `0.5`, when the metadata declares one. */
  omeZarrVersion?: string;

  /* --- context and best-effort metadata, used by the gallery --- */
  mountId: string;
  mountName: string;
  /** Zarr specification version of the group: 2 or 3. */
  zarrFormat: 2 | 3;
  /** Axis names of the multiscale, e.g. `['t','c','z','y','x']`. */
  axes?: string[];
  /** Shape of the highest-resolution array. */
  shape?: number[];
  /** Data type of the highest-resolution array, e.g. `uint16`. */
  dtype?: string;
  /** Number of resolution levels. */
  scaleCount?: number;
}

export type DiscoveryNoteKind =
  /** Something recognisable that this portal cannot open. */
  | 'unsupported'
  /** Something deliberately not treated as a dataset. */
  | 'skipped'
  /** Metadata that exists but could not be read. */
  | 'error'
  /** A traversal limit stopped the search early. */
  | 'limit';

export interface DiscoveryNote {
  kind: DiscoveryNoteKind;
  /** Human-readable location, e.g. `my-folder/plate.ome.zarr`. */
  path: string;
  message: string;
}

export interface DiscoveryResult {
  datasets: DiscoveredDataset[];
  notes: DiscoveryNote[];
  directoriesScanned: number;
}

/**
 * Bounds on the walk. A dropped folder can be anything — a home directory, a
 * plate with tens of thousands of wells — so every dimension of the search is
 * capped and the user is told when a cap was hit.
 */
export interface DiscoveryLimits {
  maxDepth: number;
  maxDatasets: number;
  maxDirectories: number;
  maxEntriesPerDirectory: number;
}

export const DEFAULT_LIMITS: DiscoveryLimits = {
  maxDepth: 10,
  maxDatasets: 1000,
  maxDirectories: 20000,
  maxEntriesPerDirectory: 5000,
};

export interface DiscoveryProgress {
  directoriesScanned: number;
  datasetsFound: number;
  currentPath: string;
}

export interface DiscoveryOptions {
  limits?: Partial<DiscoveryLimits>;
  /**
   * Build the virtual URL for a path inside a mount. Defaults to the service
   * worker's `_local/` namespace; injectable so discovery does not depend on
   * the virtual-filesystem layer (and so it can be tested without a browser).
   */
  urlBuilder?: (mountId: string, relativePath: string) => string;
  onProgress?: (progress: DiscoveryProgress) => void;
  signal?: AbortSignal;
}
