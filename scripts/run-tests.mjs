import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = mkdtempSync(path.join(tmpdir(), 'ev-test-home-'));
const home = path.join(root, 'home');
const evHome = path.join(root, 'ev');
mkdirSync(home, { recursive: true });
mkdirSync(evHome, { recursive: true });

let cleaned = false;
function cleanup() {
  if (cleaned) return;
  cleaned = true;
  rmSync(root, { recursive: true, force: true });
}

process.on('SIGINT', () => {
  cleanup();
  process.exit(130);
});
process.on('SIGTERM', () => {
  cleanup();
  process.exit(143);
});

const environment = {
  ...process.env,
  HOME: home,
  EV_HOME: evHome,
  CODEX_HOME: path.join(home, '.codex'),
  CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
  XDG_CONFIG_HOME: path.join(home, '.config'),
  XDG_DATA_HOME: path.join(home, '.local', 'share'),
};

const suites = [
  'packages/contracts',
  'packages/browser-host',
  'packages/ui',
  'apps/cli',
  'apps/server',
  'apps/desktop',
  'apps/browser-extension',
];

let exitCode = 0;
try {
  for (const suite of suites) {
    const result = spawnSync('pnpm', ['--dir', suite, 'run', 'test'], {
      cwd: path.resolve(import.meta.dirname, '..'),
      env: environment,
      stdio: 'inherit',
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      exitCode = result.status ?? 1;
      break;
    }
  }
} finally {
  cleanup();
}

process.exit(exitCode);
