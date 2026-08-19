import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

const root = fileURLToPath(new URL('./', import.meta.url));
const at = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/**
 * Serve the service worker at `/sw.js` during development.
 *
 * A worker may only claim a scope at or below its own script path, and a
 * browser will not widen that scope without a `Service-Worker-Allowed` header.
 * Serving the transformed worker from the site root in dev — exactly where the
 * build emits it — means the registration code is identical in both modes.
 */
function devServiceWorker(): Plugin {
  return {
    name: 'ome-zarr-portal:dev-service-worker',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if ((req.url ?? '').split('?')[0] !== '/sw.js') return next();
        server
          .transformRequest('/src/vfs/sw.ts')
          .then((result) => {
            if (!result) return next();
            res.setHeader('Content-Type', 'application/javascript');
            res.setHeader('Service-Worker-Allowed', '/');
            res.setHeader('Cache-Control', 'no-store');
            res.end(result.code);
          })
          .catch(next);
      });
    },
  };
}

export default defineConfig({
  root,
  // Relative base so the same build works at an origin root and at a GitHub
  // Pages project subpath (`https://<user>.github.io/<repo>/`) without being
  // rebuilt for a specific deployment path. Everything that needs an absolute
  // path derives it at runtime from the service worker's scope.
  base: './',
  // Multi-page: the landing portal and the Neuroglancer client are separate
  // documents on the same origin, so both can talk to the virtual filesystem
  // without any cross-origin machinery.
  appType: 'mpa',
  plugins: [devServiceWorker()],
  build: {
    // Neuroglancer ships modern syntax and relies on module workers.
    target: 'esnext',
    rollupOptions: {
      input: {
        portal: at('index.html'),
        neuroglancer: at('neuroglancer/index.html'),
        sw: at('src/vfs/sw.ts'),
      },
      output: {
        // The worker must sit at the deployment root to claim the whole site.
        entryFileNames: (chunk) =>
          chunk.name === 'sw' ? 'sw.js' : 'assets/[name]-[hash].js',
      },
    },
  },
  worker: { format: 'es' },
  optimizeDeps: {
    // Neuroglancer's sources use Vite-specific `?raw` asset imports and the
    // package `imports` field; esbuild pre-bundling cannot handle either.
    exclude: ['neuroglancer'],
  },
  server: {
    watch: { ignored: ['**/.nfs*'] },
  },
});
