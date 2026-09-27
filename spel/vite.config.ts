import { defineConfig } from 'vite';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Short hash of the shipped chalet assets: the build id names the exact assets a test ran on (REVIEW-01 G-18). */
function assetHash(): string {
  const h = createHash('sha256');
  for (const f of ['chalet.glb', 'chalet_coll.bin', 'arm.glb', 'lm/lm.json', 'lm/illum.json', 'probes/probes.json']) {
    const p = fileURLToPath(new URL(`./public/assets/${f}`, import.meta.url));
    if (existsSync(p)) h.update(readFileSync(p));
  }
  return h.digest('hex').slice(0, 8);
}

// Relative base: the build runs from any HTTPS path or the LAN preview. Only game files end up in dist/.
export default defineConfig({
  base: './',
  define: { __MJ_BUILD__: JSON.stringify(`G1-kandidaat-02 · ${assetHash()}`) },
  build: {
    target: 'es2022',
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 4000,
    sourcemap: false,
  },
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  preview: { host: '127.0.0.1', port: 4173, strictPort: true },
});
