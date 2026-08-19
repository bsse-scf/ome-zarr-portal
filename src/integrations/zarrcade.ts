/**
 * Zarrcade integration.
 *
 * Zarrcade v3 is a static, config-driven SPA: it loads a JSON config from
 * `?config=<url>`, fetches the CSV catalog that config names, and renders the
 * gallery. That is the whole extension point, so the portal needs no fork and
 * no patch — it generates a config and a catalog in memory, serves them from
 * the `_session/` namespace, and hands Zarrcade the URL.
 *
 * The one substantive difference from a normal Zarrcade deployment is the
 * viewer list. Zarrcade ships with external viewers (the public Neuroglancer
 * demo, Avivator, the OME-NGFF validator), none of which can reach a
 * `_local/` URL that only exists inside this browser. They are replaced with
 * the Neuroglancer bundled alongside the portal.
 */
import type { DiscoveredDataset } from '../discovery/types';
import { putSessionFile, pruneSessions, siteUrl } from '../vfs/client';
import { neuroglancerUrlTemplate } from './neuroglancer';

const PATH_COLUMN = 'path';

/** Column order in the generated catalog; `path` is the URL Zarrcade opens. */
const COLUMNS = [
  'Name',
  PATH_COLUMN,
  'Folder',
  'Location',
  'NGFF Version',
  'Zarr Format',
  'Axes',
  'Shape',
  'Data Type',
  'Levels',
] as const;

function csvEscape(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function row(dataset: DiscoveredDataset): string[] {
  return [
    dataset.name,
    dataset.virtualUrl,
    dataset.mountName,
    dataset.relativePath || '.',
    dataset.omeZarrVersion ?? 'unknown',
    `v${dataset.zarrFormat}`,
    dataset.axes?.join(', ') ?? '',
    dataset.shape?.join(' × ') ?? '',
    dataset.dtype ?? '',
    dataset.scaleCount !== undefined ? String(dataset.scaleCount) : '',
  ];
}

export function buildCatalogCsv(datasets: DiscoveredDataset[]): string {
  const lines = [COLUMNS.join(',')];
  for (const dataset of datasets) {
    lines.push(row(dataset).map(csvEscape).join(','));
  }
  return `${lines.join('\n')}\n`;
}

export function buildZarrcadeConfig(
  catalogUrl: string,
  title: string,
  datasets: DiscoveredDataset[],
): unknown {
  return {
    title,
    dataUrl: catalogUrl,
    data: { delimiter: ',', pathColumn: PATH_COLUMN },
    display: {
      titleColumn: 'Name',
      // The virtual URL is an implementation detail; the gallery shows
      // `Folder` and `Location` instead, which mean something to the user.
      hideColumns: [PATH_COLUMN],
      pageSize: 50,
    },
    filters: [
      { column: 'Folder', label: 'Folder' },
      { column: 'NGFF Version', label: 'NGFF version' },
      { column: 'Data Type', label: 'Data type' },
    ],
    viewers: [
      {
        name: 'Neuroglancer',
        icon: 'neuroglancer.png',
        urlTemplate: neuroglancerUrlTemplate(datasets),
        enabled: true,
      },
    ],
  };
}

export interface ZarrcadeSession {
  sessionId: string;
  /** URL of the Zarrcade SPA, configured for these datasets. */
  url: string;
  configUrl: string;
  catalogUrl: string;
}

/**
 * Publish a gallery for the given datasets and return the URL to open.
 *
 * Older sessions are pruned: their catalogs point at mounts that may no longer
 * exist, so keeping them only leaves dead links in the browser history.
 */
export async function createZarrcadeSession(
  datasets: DiscoveredDataset[],
  title = 'Local OME-Zarr gallery',
): Promise<ZarrcadeSession> {
  const sessionId = crypto.randomUUID();

  const catalogUrl = await putSessionFile(
    sessionId,
    'catalog.csv',
    buildCatalogCsv(datasets),
    'text/csv; charset=utf-8',
  );
  const configUrl = await putSessionFile(
    sessionId,
    'config.json',
    JSON.stringify(buildZarrcadeConfig(catalogUrl, title, datasets), null, 2),
    'application/json',
  );

  await pruneSessions(sessionId);

  return {
    sessionId,
    url: `${siteUrl('zarrcade/index.html')}?config=${encodeURIComponent(configUrl)}`,
    configUrl,
    catalogUrl,
  };
}
