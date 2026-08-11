import { readFile, writeFile } from 'node:fs/promises';

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error('Usage: pnpm exec tsx scripts/set-release-version.ts <semver>');
}

const packageFiles = [
  'package.json',
  'apps/desktop/package.json',
  'apps/browser-extension/package.json',
  'apps/cli/package.json',
  'packages/browser-host/package.json',
  'packages/contracts/package.json',
  'packages/design-tokens/package.json',
] as const;

for (const path of packageFiles) {
  const value = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  value.version = version;
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

console.log(`Updated workspace versions to ${version}`);
