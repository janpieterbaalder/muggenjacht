// Bundles each tests/*.test.ts with rolldown (ships with Vite 8) and runs them with node --test.
import { build } from 'rolldown';
import { readdirSync, rmSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', '.test-build');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const files = readdirSync(here).filter((f) => f.endsWith('.test.ts'));
for (const f of files) {
  await build({
    input: join(here, f),
    platform: 'node',
    external: [/^node:/],
    // rolldown takes define under transform (top-level define was ignored: import.meta.env stayed undefined, G-18)
    transform: { define: { 'import.meta.env.BASE_URL': '"./"', 'import.meta.env.DEV': 'false', __MJ_BUILD__: '"test"' } },
    // one file per test: dynamic imports inside Babylon's loaders are inlined
    output: { file: join(out, f.replace(/\.ts$/, '.mjs')), format: 'esm', codeSplitting: false },
    logLevel: 'warn',
  });
}
const r = spawnSync(process.execPath, ['--test', ...files.map((f) => join(out, f.replace(/\.ts$/, '.mjs')))], { stdio: 'inherit' });
process.exit(r.status ?? 1);
