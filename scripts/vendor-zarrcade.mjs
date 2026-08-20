/**
 * Copy the prebuilt Zarrcade SPA into `public/zarrcade/` so it is served from
 * the portal's own origin at `/zarrcade/`.
 *
 * Zarrcade v3 is a static, config-driven SPA built with a relative base
 * (`base: './'`), so it runs unmodified from any subpath. The portal drives it
 * entirely through `?config=<url>`; see `src/integrations/zarrcade.ts`.
 *
 * The only file we deliberately drop is Zarrcade's stock `config.json`: it
 * points its Neuroglancer viewer at the public demo instance, which cannot
 * reach our `/_local/...` URLs. Omitting it makes a bare visit to `/zarrcade/`
 * show Zarrcade's own Welcome screen instead.
 *
 * The only thing added is `zarrcade/local-data.css`, linked from the SPA's
 * `index.html`. It hides the controls that only make sense for data published
 * on the web; see the file for what and why. Linking it here rather than
 * injecting it from the portal page means it also applies when the gallery is
 * opened in a tab of its own.
 */
import { cp, readFile, rm, mkdir, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const src = new URL('node_modules/@janelia/zarrcade/dist/', root);
const dest = new URL('public/zarrcade/', root);

try {
  await stat(src);
} catch {
  console.error(
    'Zarrcade dist not found. Run `npm install` first (dev dependency: @janelia/zarrcade).',
  );
  process.exit(1);
}

await rm(dest, { recursive: true, force: true });
await mkdir(dest, { recursive: true });
await cp(src, dest, { recursive: true });
await rm(new URL('config.json', dest), { force: true });

const STYLESHEET = 'local-data.css';
await cp(new URL(`zarrcade/${STYLESHEET}`, root), new URL(STYLESHEET, dest));

const indexPath = new URL('index.html', dest);
const index = await readFile(indexPath, 'utf8');
if (!index.includes('</head>')) {
  // Fail loudly rather than shipping a gallery still offering dead links.
  console.error('Zarrcade index.html has no </head> to link the stylesheet from.');
  process.exit(1);
}
await writeFile(
  indexPath,
  index.replace('</head>', `  <link rel="stylesheet" href="./${STYLESHEET}" />\n  </head>`),
);

console.log(`Vendored Zarrcade SPA -> ${fileURLToPath(dest)}`);
