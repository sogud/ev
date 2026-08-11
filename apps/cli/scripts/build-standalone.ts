import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// Node single-executable application (SEA) replaces the old single-file compile flow:
// bundle a CommonJS main with esbuild, prepare the SEA blob, then inject it
// into a copy of the running node binary with postject.
const executableName = `ev-${process.platform}-${process.arch}${process.platform === 'win32' ? '.exe' : ''}`;
const outputPath = path.join('dist', executableName);
const mainPath = path.join('dist', 'sea-main.cjs');
const blobPath = path.join('dist', 'sea-prep.blob');
const configPath = path.join('dist', 'sea-config.json');

function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run('esbuild', [
  'src/cli.ts',
  '--bundle',
  '--platform=node',
  '--format=cjs',
  `--outfile=${mainPath}`,
]);
writeFileSync(
  configPath,
  JSON.stringify({ main: mainPath, output: blobPath, disableExperimentalSEAWarning: true })
);
run(process.execPath, ['--experimental-sea-config', configPath]);
copyFileSync(process.execPath, outputPath);
if (process.platform === 'darwin') run('codesign', ['--remove-signature', outputPath]);
run('postject', [
  outputPath,
  'NODE_SEA_BLOB',
  blobPath,
  '--sentinel-fuse',
  'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  ...(process.platform === 'darwin' ? ['--macho-segment-name', 'NODE_SEA'] : []),
]);
if (process.platform === 'darwin') run('codesign', ['--sign', '-', outputPath]);
chmodSync(outputPath, 0o755);
console.log(`Built ${outputPath}`);
