import { chmod, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

interface CliLauncherOptions {
  homeDirectory: string;
  /** Defaults to <homeDirectory>/.ev/bin; isolated runs point it at their EV_HOME. */
  binDirectory?: string;
  executablePath: string;
  cliScript: string;
  platform?: NodeJS.Platform;
  currentPath?: string;
}

export interface CliLauncherResult {
  launcherPath: string;
  path: string;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export async function ensureEvCliLauncher(options: CliLauncherOptions): Promise<CliLauncherResult> {
  const platform = options.platform ?? process.platform;
  const binDirectory = options.binDirectory ?? path.join(options.homeDirectory, '.ev', 'bin');
  await mkdir(binDirectory, { recursive: true, mode: 0o700 });
  await chmod(binDirectory, 0o700);

  const isWindows = platform === 'win32';
  const launcherPath = path.join(binDirectory, isWindows ? 'ev.cmd' : 'ev');
  const content = isWindows
    ? ['@echo off', `"${options.executablePath}" "${options.cliScript}" %*`, ''].join('\r\n')
    : [
        '#!/bin/sh',
        `exec ${shellQuote(options.executablePath)} ${shellQuote(options.cliScript)} "$@"`,
        '',
      ].join('\n');
  await writeFile(launcherPath, content, { mode: 0o700 });
  if (!isWindows) await chmod(launcherPath, 0o700);

  const currentPath = options.currentPath ?? process.env.PATH ?? '';
  const entries = currentPath.split(path.delimiter).filter(Boolean);
  const nextPath = [binDirectory, ...entries.filter(entry => entry !== binDirectory)].join(
    path.delimiter
  );
  return { launcherPath, path: nextPath };
}
