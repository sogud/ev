import { readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

const workspaceRoot = resolve(import.meta.dir, '..');
const packagePath = resolve(workspaceRoot, 'apps/desktop/package.json');
const packageJson = JSON.parse(await readFile(packagePath, 'utf8')) as { version?: string };
const version = packageJson.version;

if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error(`Refusing to clean an invalid release version: ${version ?? '<missing>'}`);
}

const outputPath = resolve(workspaceRoot, 'apps/desktop/release', version);
await rm(outputPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
console.log(`Cleaned apps/desktop/release/${version}`);
