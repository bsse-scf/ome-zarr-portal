/**
 * A short "how do I move around?" card in the viewer's top bar.
 *
 * Neuroglancer already has a help panel — the `?` button, or `h` — but it is
 * the complete list of every binding, several hundred rows of it, which is the
 * wrong first thing to hand someone who has just dropped a folder on the
 * portal and wants to look at their image. This adds a second, smaller button
 * beside it holding only the handful of gestures that get you around an image,
 * and points at the full list for everything else.
 */
import type { Viewer } from 'neuroglancer/unstable/viewer.js';
import { makeIcon } from 'neuroglancer/unstable/widget/icon.js';

import './navigation-help.css';

interface Shortcut {
  /** Keys and mouse gestures, each shown as its own key cap. */
  keys: string[];
  /** What goes between the caps: `+` for a combination, `or` for a choice. */
  joiner?: string;
  does: string;
}

/**
 * Enough to navigate an image and nothing more.
 *
 * These are Neuroglancer's stock bindings, not portal ones. `[` and `]` step
 * along the first dimension that is not being displayed, which for the images
 * this portal opens is time — see `keepTimeScrollable` in `main.ts`.
 */
const SHORTCUTS: readonly Shortcut[] = [
  { keys: ['Drag'], does: 'Pan the image' },
  { keys: ['Scroll'], does: 'Move through z, a slice at a time' },
  { keys: ['Ctrl', 'scroll'], joiner: '+', does: 'Zoom in and out' },
  { keys: ['Shift', 'drag'], joiner: '+', does: 'Tilt the slice plane' },
  { keys: ['[', ']'], joiner: 'or', does: 'Step back and forward in time' },
  { keys: ['Space'], does: 'Enlarge the panel under the pointer' },
  { keys: ['h'], does: 'Every shortcut, in Neuroglancer’s own help' },
];

const NOTE =
  'Any axis can also be moved by scrolling on its value in this bar, ' +
  'and brightness, contrast and colour live behind the sliders button.';

function buildCard(): HTMLElement {
  const card = document.createElement('div');
  card.className = 'portal-navigation-help-card';
  card.hidden = true;
  // A card, not a dialog: it never takes focus away from the viewer, so the
  // keys it describes keep working while it is open.
  card.setAttribute('role', 'group');
  card.setAttribute('aria-label', 'Navigating the viewer');

  const heading = document.createElement('h2');
  heading.textContent = 'Getting around';
  card.appendChild(heading);

  const list = document.createElement('dl');
  for (const { keys, joiner, does } of SHORTCUTS) {
    const term = document.createElement('dt');
    keys.forEach((key, index) => {
      if (index > 0) term.append(` ${joiner} `);
      const cap = document.createElement('kbd');
      cap.textContent = key;
      term.appendChild(cap);
    });
    const description = document.createElement('dd');
    description.textContent = does;
    list.append(term, description);
  }
  card.appendChild(list);

  const note = document.createElement('p');
  note.textContent = NOTE;
  card.appendChild(note);

  return card;
}

/** Add the button and its card to the viewer's top bar. */
export function addNavigationHelp(viewer: Viewer): void {
  const topRow = viewer.element.querySelector('.neuroglancer-viewer-top-row');
  if (topRow === null) return;

  const card = buildCard();
  const button = makeIcon({ text: 'i', title: 'How to navigate' });
  button.setAttribute('aria-expanded', 'false');

  const setOpen = (open: boolean): void => {
    card.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
  };

  button.addEventListener('click', () => setOpen(card.hidden));

  // Anything else — a click in a panel, Escape — puts the card away again,
  // the way the viewer's own menus behave.
  document.addEventListener('pointerdown', (event) => {
    const target = event.target as Node;
    if (!card.hidden && !card.contains(target) && !button.contains(target)) {
      setOpen(false);
    }
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !card.hidden) setOpen(false);
  });

  // The container is what the card is positioned against, so it follows the
  // button however wide the rest of the bar grows.
  const container = document.createElement('div');
  container.className = 'portal-navigation-help';
  container.append(button, card);
  topRow.appendChild(container);
}
