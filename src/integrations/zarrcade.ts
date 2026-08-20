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
 * demo, Avivator, the OME-Zarr validator), none of which can reach a
 * `_local/` URL that only exists inside this browser. They are replaced with
 * the Neuroglancer bundled alongside the portal.
 */
import type { DiscoveredImage } from '../discovery/types';
import { previewUrl, putSessionFile, pruneSessions, siteUrl } from '../vfs/client';
import { neuroglancerUrlTemplate } from './neuroglancer';

const PATH_COLUMN = 'path';
const THUMBNAIL_COLUMN = 'thumbnail';

/** Column order in the generated catalog; `path` is the URL Zarrcade opens. */
const COLUMNS = [
  'Name',
  PATH_COLUMN,
  THUMBNAIL_COLUMN,
  'Folder',
  'Location',
  'OME-Zarr Version',
  'Axes',
  'Shape',
  'Data Type',
  'Resolution Levels',
] as const;

function csvEscape(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * Choose what fills a row's thumbnail cell.
 *
 * Empty is meaningful: with no CSV thumbnail, Zarrcade falls back to its own
 * Zarr `thumbnails` convention lookup, and then to a placeholder icon. So an
 * image that ships real thumbnails is left empty on purpose — upstream reads
 * them directly and picks the best-sized entry, which beats anything we could
 * substitute. Only when there is no thumbnail do we point at a generated
 * projection, and only when one can actually be produced.
 */
function thumbnailCell(image: DiscoveredImage): string {
  if (image.hasConventionThumbnail) return '';
  if (!image.previewable) return '';
  return previewUrl(image.mountId, image.relativePath);
}

/**
 * The OME-Zarr version, as the community writes it: `0.5` is v5.
 *
 * Metadata that declares no version at all still says which layout it is
 * written in, and that narrows it down: `zarr.json` means v5, and the older
 * files mean v4 or earlier.
 */
function versionCell(image: DiscoveredImage): string {
  if (image.omeZarrVersion) return `v${image.omeZarrVersion.replace(/^0\./, '')}`;
  return image.layout === 'v5' ? 'v5' : 'v4 or earlier';
}

function row(image: DiscoveredImage): string[] {
  return [
    image.name,
    image.virtualUrl,
    thumbnailCell(image),
    image.mountName,
    image.relativePath || '.',
    versionCell(image),
    image.axes?.join(', ') ?? '',
    image.shape?.join(' × ') ?? '',
    image.dtype ?? '',
    image.levelCount !== undefined ? String(image.levelCount) : '',
  ];
}

export function buildCatalogCsv(images: DiscoveredImage[]): string {
  const lines = [COLUMNS.join(',')];
  for (const image of images) {
    lines.push(row(image).map(csvEscape).join(','));
  }
  return `${lines.join('\n')}\n`;
}

export function buildZarrcadeConfig(
  catalogUrl: string,
  title: string,
  images: DiscoveredImage[],
): unknown {
  return {
    title,
    dataUrl: catalogUrl,
    data: {
      delimiter: ',',
      pathColumn: PATH_COLUMN,
      thumbnailColumn: THUMBNAIL_COLUMN,
    },
    display: {
      titleColumn: 'Name',
      // Both URLs are implementation detail; the gallery shows `Folder` and
      // `Location` instead, which mean something to the user.
      hideColumns: [PATH_COLUMN, THUMBNAIL_COLUMN],
      pageSize: 50,
    },
    filters: [
      { column: 'Folder', label: 'Folder' },
      { column: 'OME-Zarr Version', label: 'OME-Zarr version' },
      { column: 'Data Type', label: 'Data type' },
    ],
    viewers: [
      {
        name: 'Neuroglancer',
        icon: 'neuroglancer.png',
        urlTemplate: neuroglancerUrlTemplate(images),
        enabled: true,
      },
    ],
  };
}

export interface ZarrcadeSession {
  sessionId: string;
  /** URL of the Zarrcade SPA, configured for these images. */
  url: string;
  configUrl: string;
  catalogUrl: string;
}

/**
 * Publish a gallery for the given images and return the URL to open.
 *
 * Older sessions are pruned: their catalogs point at mounts that may no longer
 * exist, so keeping them only leaves dead links in the browser history.
 */
export async function createZarrcadeSession(
  images: DiscoveredImage[],
  title = 'Local OME-Zarr gallery',
): Promise<ZarrcadeSession> {
  const sessionId = crypto.randomUUID();

  const catalogUrl = await putSessionFile(
    sessionId,
    'catalog.csv',
    buildCatalogCsv(images),
    'text/csv; charset=utf-8',
  );
  const configUrl = await putSessionFile(
    sessionId,
    'config.json',
    JSON.stringify(buildZarrcadeConfig(catalogUrl, title, images), null, 2),
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
