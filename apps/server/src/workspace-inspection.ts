import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { WorkspaceChanges } from '@ev/contracts/domain';

const execFileAsync = promisify(execFile);

export async function inspectWorkspace(cwd: string): Promise<WorkspaceChanges> {
  try {
    await execFileAsync('git', ['rev-parse', '--is-inside-work-tree'], { cwd, timeout: 5_000 });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      isGitRepository: false,
      files: [],
      diff: '',
      error: message.includes('not a git repository') ? undefined : message,
    };
  }

  try {
    const [statusResult, diffResult] = await Promise.all([
      execFileAsync('git', ['status', '--short'], { cwd, timeout: 10_000, maxBuffer: 2_000_000 }),
      execFileAsync('git', ['diff', '--no-ext-diff', '--unified=3'], {
        cwd,
        timeout: 10_000,
        maxBuffer: 4_000_000,
      }),
    ]);
    return {
      isGitRepository: true,
      files: statusResult.stdout
        .split('\n')
        .filter(Boolean)
        .map(line => ({ status: line.slice(0, 2).trim() || '?', path: line.slice(3) })),
      diff: diffResult.stdout,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      isGitRepository: true,
      files: [],
      diff: '',
      error: message,
    };
  }
}
