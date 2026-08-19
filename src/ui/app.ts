/**
 * Landing-page controller: drop zones, discovery progress, and routing to the
 * two viewers.
 */
import { discoverInMounts } from '../discovery/discover';
import type { DiscoveredDataset, DiscoveryNote } from '../discovery/types';
import { neuroglancerUrl } from '../integrations/neuroglancer';
import { createZarrcadeSession } from '../integrations/zarrcade';
import {
  extractHandles,
  isDirectoryPickerSupported,
  isDropSupported,
  type DropExtraction,
} from '../mounts/drop';
import {
  createMount,
  listMounts,
  mountRootUrl,
  pruneUnreadableMounts,
  removeAllMounts,
  type Mount,
} from '../mounts/registry';
import { ensureServiceWorker, getBasePath, ServiceWorkerUnavailableError } from '../vfs/client';

type Target = 'neuroglancer' | 'gallery';

const TARGET_LABELS: Record<Target, string> = {
  neuroglancer: 'Neuroglancer',
  gallery: 'Zarrcade gallery',
};

function element<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element #${id}`);
  return node as T;
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/**
 * Write prose that may contain `backticked` spans, rendering those as `code`.
 *
 * The copy stays readable where it is written, and the page never shows a
 * stray backtick — which `textContent` alone would.
 */
function setProse(node: HTMLElement, text: string): void {
  node.replaceChildren(
    ...text.split('`').map((part, index) => {
      if (index % 2 === 0) return document.createTextNode(part);
      const code = document.createElement('code');
      code.textContent = part;
      return code;
    }),
  );
}

export function startApp(): void {
  const status = element<HTMLElement>('status');
  const mountsSection = element<HTMLElement>('mounts');
  const mountList = element<HTMLUListElement>('mount-list');
  const viewer = element<HTMLElement>('viewer');
  const viewerFrame = element<HTMLIFrameElement>('viewer-frame');
  const viewerTitle = element<HTMLElement>('viewer-title');
  const viewerOpen = element<HTMLAnchorElement>('viewer-open');
  const viewerBack = element<HTMLButtonElement>('viewer-back');
  const namespaceExample = element<HTMLElement>('namespace-example');

  const dropzones = Array.from(
    document.querySelectorAll<HTMLElement>('.dropzone'),
  );

  namespaceExample.textContent = `${getBasePath()}_local/…`;

  let busy = false;

  /* ------------------------------------------------------------ rendering */

  function clear(node: HTMLElement): void {
    node.replaceChildren();
  }

  function setStatus(
    headline: string,
    options: { detail?: string; error?: boolean } = {},
  ): HTMLElement {
    clear(status);
    status.hidden = false;
    status.classList.toggle('is-error', Boolean(options.error));

    const heading = document.createElement('p');
    heading.className = 'status-headline';
    heading.textContent = headline;
    status.append(heading);

    if (options.detail) {
      const detail = document.createElement('p');
      setProse(detail, options.detail);
      status.append(detail);
    }
    return status;
  }

  function renderNotes(notes: DiscoveryNote[]): void {
    if (notes.length === 0) return;
    const list = document.createElement('ul');
    list.className = 'notes';
    for (const note of notes) {
      const item = document.createElement('li');

      const kind = document.createElement('span');
      kind.className = 'note-kind';
      kind.dataset.kind = note.kind;
      kind.textContent = note.kind;

      const body = document.createElement('span');
      const path = document.createElement('span');
      path.className = 'note-path';
      path.textContent = note.path;
      const message = document.createElement('span');
      message.className = 'note-message';
      setProse(message, ` — ${note.message}`);
      body.append(path, message);

      item.append(kind, body);
      list.append(item);
    }
    status.append(list);
  }

  function renderActions(actions: Array<{ label: string; onClick: () => void }>): void {
    if (actions.length === 0) return;
    const row = document.createElement('div');
    row.className = 'status-actions';
    for (const action of actions) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = action.label;
      button.addEventListener('click', action.onClick);
      row.append(button);
    }
    status.append(row);
  }

  async function renderMounts(): Promise<void> {
    const mounts = await listMounts();
    clear(mountList);
    mountsSection.hidden = mounts.length === 0;

    for (const mount of mounts) {
      const item = document.createElement('li');

      const name = document.createElement('span');
      name.className = 'mount-name';
      name.textContent = mount.name;

      const url = document.createElement('span');
      url.className = 'mount-url';
      const path = new URL(mountRootUrl(mount.id)).pathname;
      url.textContent = path;
      url.title = path;

      item.append(name, url);
      mountList.append(item);
    }
  }

  /* -------------------------------------------------------------- viewers */

  function openViewer(url: string, title: string): void {
    viewerTitle.textContent = title;
    viewerOpen.href = url;
    viewerFrame.src = url;
    viewer.hidden = false;
    document.body.style.overflow = 'hidden';
  }

  function closeViewer(): void {
    viewer.hidden = true;
    // Drop the frame so a hidden Neuroglancer stops holding a WebGL context
    // and reading chunks in the background.
    viewerFrame.removeAttribute('src');
    document.body.style.overflow = '';
  }

  viewerBack.addEventListener('click', closeViewer);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !viewer.hidden) closeViewer();
  });

  async function show(target: Target, datasets: DiscoveredDataset[]): Promise<void> {
    if (target === 'neuroglancer') {
      openViewer(neuroglancerUrl(datasets), `Neuroglancer — ${plural(datasets.length, 'layer')}`);
      return;
    }
    const session = await createZarrcadeSession(datasets);
    openViewer(session.url, `Zarrcade — ${plural(datasets.length, 'dataset')}`);
  }

  /* ------------------------------------------------------------ main flow */

  function setBusy(value: boolean): void {
    busy = value;
    for (const zone of dropzones) zone.classList.toggle('is-busy', value);
  }

  async function run(target: Target, extraction: DropExtraction): Promise<void> {
    const { directories, files, problems } = extraction;

    if (directories.length === 0) {
      const detail =
        files.length > 0
          ? 'An OME-Zarr dataset is a folder, not a single file. Drop the folder that contains `zarr.json` or `.zgroup`.'
          : 'Nothing readable was dropped.';
      setStatus('No folder to open', { detail, error: true });
      renderNotes(problems.map((message) => ({ kind: 'error', path: '—', message })));
      return;
    }

    setBusy(true);
    try {
      await ensureServiceWorker();

      const mounts: Mount[] = [];
      for (const handle of directories) {
        mounts.push(await createMount(handle));
      }
      await renderMounts();

      setStatus(`Searching ${plural(mounts.length, 'folder')} for OME-Zarr datasets…`);
      const progress = document.createElement('p');
      progress.className = 'status-progress';
      const progressPath = document.createElement('span');
      progressPath.className = 'status-path';
      status.append(progress, progressPath);

      let lastPaint = 0;
      const result = await discoverInMounts(mounts, {
        onProgress: (update) => {
          // Repainting on every directory would dominate the walk's cost.
          const now = performance.now();
          if (now - lastPaint < 100) return;
          lastPaint = now;
          progress.textContent = `${plural(update.datasetsFound, 'dataset')} found · ${plural(
            update.directoriesScanned,
            'folder',
          )} scanned`;
          progressPath.textContent = update.currentPath;
        },
      });

      const { datasets, notes } = result;

      if (datasets.length === 0) {
        setStatus('No OME-Zarr datasets found', {
          detail:
            'The portal looks for Zarr groups carrying OME-NGFF `multiscales` metadata, in both the Zarr v2 and v3 layouts.',
          error: true,
        });
        renderNotes(notes);
        return;
      }

      setStatus(
        `Found ${plural(datasets.length, 'dataset')} in ${plural(
          result.directoriesScanned,
          'folder',
        )}.`,
        { detail: `Opening ${TARGET_LABELS[target]}…` },
      );
      renderNotes(notes);
      renderActions([
        {
          label: `Open in ${TARGET_LABELS[target]}`,
          onClick: () => void show(target, datasets),
        },
        {
          label:
            target === 'neuroglancer' ? 'Open the gallery instead' : 'Open in Neuroglancer instead',
          onClick: () =>
            void show(target === 'neuroglancer' ? 'gallery' : 'neuroglancer', datasets),
        },
      ]);

      await show(target, datasets);
    } catch (error) {
      if (error instanceof ServiceWorkerUnavailableError) {
        setStatus('Cannot serve local files', { detail: error.message, error: true });
      } else {
        setStatus('Something went wrong', {
          detail: error instanceof Error ? error.message : String(error),
          error: true,
        });
      }
    } finally {
      setBusy(false);
    }
  }

  /* --------------------------------------------------------------- events */

  for (const zone of dropzones) {
    const target = zone.dataset.target as Target;

    // `dragover` must be cancelled for a drop to be delivered at all.
    zone.addEventListener('dragover', (event) => {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
      zone.classList.add('is-over');
    });
    zone.addEventListener('dragenter', () => zone.classList.add('is-over'));
    zone.addEventListener('dragleave', (event) => {
      // Ignore the leave events fired when crossing into a child element.
      if (!zone.contains(event.relatedTarget as Node | null)) zone.classList.remove('is-over');
    });

    zone.addEventListener('drop', (event) => {
      event.preventDefault();
      zone.classList.remove('is-over');
      if (busy || !event.dataTransfer) return;

      if (!isDropSupported()) {
        setStatus('This browser cannot hand over dropped folders', {
          detail:
            'The portal needs the File System Access API (getAsFileSystemHandle), which today means a Chromium-based browser such as Chrome or Edge.',
          error: true,
        });
        return;
      }

      // Must be called before any await: the item list is only valid during
      // this event's dispatch.
      const extraction = extractHandles(event.dataTransfer);
      void extraction.then((result) => run(target, result));
    });
  }

  for (const button of document.querySelectorAll<HTMLButtonElement>('.browse')) {
    const target = button.dataset.target as Target;
    if (!isDirectoryPickerSupported()) {
      button.hidden = true;
      continue;
    }
    button.addEventListener('click', async () => {
      if (busy) return;
      let handle: FileSystemDirectoryHandle;
      try {
        handle = await window.showDirectoryPicker!({ mode: 'read', id: 'ome-zarr-portal' });
      } catch {
        return; // The picker was dismissed.
      }
      await run(target, { directories: [handle], files: [], problems: [] });
    });
  }

  element<HTMLButtonElement>('unmount-all').addEventListener('click', async () => {
    await removeAllMounts();
    await renderMounts();
    setStatus('All folders unmounted.', {
      detail: 'Their virtual URLs no longer resolve.',
    });
  });

  /* ---------------------------------------------------------------- start */

  void (async () => {
    try {
      await ensureServiceWorker();
    } catch (error) {
      setStatus('Cannot serve local files', {
        detail: error instanceof Error ? error.message : String(error),
        error: true,
      });
      return;
    }

    // Handles survive a reload but their permission grant does not, so clear
    // out anything we can no longer read rather than showing dead mounts.
    const dropped = await pruneUnreadableMounts();
    await renderMounts();
    if (dropped > 0) {
      setStatus(`${plural(dropped, 'folder')} from the previous session was unmounted.`, {
        detail: 'Browsers do not carry folder permissions across a reload — drop it again to continue.',
      });
    }
  })();
}
