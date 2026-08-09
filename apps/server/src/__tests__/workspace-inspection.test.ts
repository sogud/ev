import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { inspectWorkspace } from '../workspace-inspection';

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true }))
  );
});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'agent-inspection-'));
  temporaryDirectories.push(path);
  return path;
}

describe('workspace inspection', () => {
  it('identifies directories outside a git repository', async () => {
    const path = await temporaryDirectory();
    await expect(inspectWorkspace(path)).resolves.toMatchObject({
      isGitRepository: false,
      files: [],
    });
  });

  it('returns changed files and a unified diff', async () => {
    const path = await temporaryDirectory();
    await execFileAsync('git', ['init'], { cwd: path });
    await writeFile(join(path, 'note.txt'), 'before\n');
    await execFileAsync('git', ['add', 'note.txt'], { cwd: path });
    await execFileAsync(
      'git',
      ['-c', 'user.name=Agent', '-c', 'user.email=agent@example.com', 'commit', '-m', 'initial'],
      { cwd: path }
    );
    await writeFile(join(path, 'note.txt'), 'after\n');

    const result = await inspectWorkspace(path);
    expect(result.files).toContainEqual({ status: 'M', path: 'note.txt' });
    expect(result.diff).toContain('+after');
  });
});
