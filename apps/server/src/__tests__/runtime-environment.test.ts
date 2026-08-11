import { execFile } from 'node:child_process';
import { accessSync, constants, readdirSync } from 'node:fs';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { detectUserPath, runtimeChildEnvironment } from '../runtime/executable';

const execFileAsync = promisify(execFile);
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true })));
});

function knownNodeAvailable(): boolean {
  const home = os.homedir();
  const candidates = [
    '/usr/local/bin/node',
    '/opt/homebrew/bin/node',
    path.join(home, '.npm-global', 'bin', 'node'),
    path.join(home, '.local', 'bin', 'node'),
  ];
  try {
    const nvmRoot = path.join(home, '.nvm', 'versions', 'node');
    for (const version of readdirSync(nvmRoot)) {
      candidates.push(path.join(nvmRoot, version, 'bin', 'node'));
    }
  } catch {
    // nvm is optional.
  }
  return candidates.some(candidate => {
    try {
      accessSync(candidate, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

describe('runtimeChildEnvironment', () => {
  it('augments a minimal GUI PATH with user and system tool directories', async () => {
    const env = await runtimeChildEnvironment({ HOME: os.homedir(), PATH: '/usr/bin:/bin' });
    const entries = env.PATH?.split(path.delimiter) ?? [];
    expect(entries).toContain('/usr/bin');
    expect(entries).toContain('/usr/local/bin');
    expect(entries).toContain(path.join(os.homedir(), '.npm-global', 'bin'));
    expect(entries).toContain(path.dirname(process.execPath));
  });

  it.skipIf(process.platform === 'win32')(
    'detects the login-shell PATH automatically',
    async () => {
      const detected = await detectUserPath({ HOME: os.homedir(), PATH: '/usr/bin:/bin' });
      expect(detected).toBeTruthy();
      expect(detected?.split(path.delimiter)).toContain('/usr/bin');
    },
    10_000
  );

  it.skipIf(!knownNodeAvailable())(
    'keeps `#!/usr/bin/env node` CLIs executable when the base PATH is minimal',
    async () => {
      const directory = await mkdtemp(path.join(os.tmpdir(), 'ev-runtime-env-'));
      directories.push(directory);
      const script = path.join(directory, 'fake-node-cli');
      await writeFile(script, '#!/usr/bin/env node\nconsole.log(JSON.stringify({ ok: true }));\n');
      await chmod(script, 0o755);

      const env = await runtimeChildEnvironment({ HOME: os.homedir(), PATH: '/usr/bin:/bin' });
      const { stdout } = await execFileAsync(script, [], { env });
      expect(JSON.parse(stdout)).toEqual({ ok: true });
    }
  );
});
