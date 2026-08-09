import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, relative, resolve } from 'node:path';

const workspaceRoot = process.cwd();
const rootPackage = JSON.parse(await readFile('package.json', 'utf8')) as { version?: string };
const version = rootPackage.version;
if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error(`Invalid release version: ${version ?? '<missing>'}`);
}
const desktopRoot = resolve('apps/desktop/release', version);
const extensionRoot = resolve('apps/browser-extension/.output');
const cliRoot = resolve('apps/cli/dist');
const outputPath = resolve('apps/desktop/release/SHA256SUMS.txt');

async function collectFiles(root: string, matches: (path: string) => boolean): Promise<string[]> {
  const files: string[] = [];

  async function visit(directory: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }

    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && matches(path)) files.push(path);
    }
  }

  await visit(root);
  return files;
}

async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolveStream, reject) => {
    const stream = createReadStream(path);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', resolveStream);
    stream.on('error', reject);
  });
  return hash.digest('hex');
}

const desktopFiles = await collectFiles(
  desktopRoot,
  path => path.endsWith('.dmg') || path.endsWith('.zip') || path.endsWith('latest-mac.yml')
);
const extensionFiles = await collectFiles(
  extensionRoot,
  path => path.endsWith(`-${version}-chrome.zip`) || path.endsWith(`-${version}-firefox.zip`)
);
const cliFiles = await collectFiles(
  cliRoot,
  path => /^ev-(?:darwin|linux|win32)-/.test(basename(path)) || path.endsWith(`-${version}.tgz`)
);

if (!desktopFiles.some(path => path.endsWith('.dmg'))) {
  throw new Error('Desktop DMG is missing');
}
if (!desktopFiles.some(path => path.endsWith('.zip'))) {
  throw new Error('Desktop ZIP is missing');
}
if (!extensionFiles.some(path => path.endsWith('-chrome.zip'))) {
  throw new Error('Chrome extension ZIP is missing');
}
if (!extensionFiles.some(path => path.endsWith('-firefox.zip'))) {
  throw new Error('Firefox extension ZIP is missing');
}
if (!cliFiles.some(path => /^ev-(?:darwin|linux|win32)-/.test(basename(path)))) {
  throw new Error('Standalone CLI executable is missing');
}
if (!cliFiles.some(path => path.endsWith('.tgz'))) {
  throw new Error('npm CLI package is missing');
}

const files = [...desktopFiles, ...extensionFiles, ...cliFiles].sort();
const lines: string[] = [];
for (const path of files) {
  lines.push(`${await sha256(path)}  ${relative(workspaceRoot, path)}`);
}
await writeFile(outputPath, `${lines.join('\n')}\n`);
console.log(`Wrote ${relative(workspaceRoot, outputPath)} for ${files.length} artifacts`);
