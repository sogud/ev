import { spawnSync } from 'node:child_process';
import path from 'node:path';

const executableName = `ev-${process.platform}-${process.arch}${process.platform === 'win32' ? '.exe' : ''}`;
const outputPath = path.join('dist', executableName);
const result = spawnSync(
  process.execPath,
  ['build', '--compile', 'src/cli.ts', '--outfile', outputPath],
  { stdio: 'inherit' }
);
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
console.log(`Built ${outputPath}`);
