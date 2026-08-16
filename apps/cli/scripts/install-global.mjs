// Keep the global `ev` launcher tracking this build: every CLI build rewrites
// ~/.ev/bin/ev to exec the freshly built dist/ev.js. Idempotent; EV_HOME isolates tests.
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const evJs = join(here, '../dist/ev.js');
const binDir = process.env.EV_HOME?.trim()
  ? join(process.env.EV_HOME.trim(), 'bin')
  : join(homedir(), '.ev', 'bin');

mkdirSync(binDir, { recursive: true, mode: 0o700 });
const launcher = join(binDir, 'ev');
writeFileSync(launcher, `#!/bin/sh\nexec '${process.execPath}' '${evJs}' "$@"\n`, {
  mode: 0o700,
});
console.log(`global ev launcher -> ${evJs}`);
