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
 */
import { cp, rm, mkdir, stat } from 'node:fs/promises';
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

console.log(`Vendored Zarrcade SPA -> ${fileURLToPath(dest)}`);
