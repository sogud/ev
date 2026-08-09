import { readFile } from 'node:fs/promises';

const packageFiles = [
  'package.json',
  'apps/desktop/package.json',
  'apps/browser-extension/package.json',
  'apps/cli/package.json',
  'packages/browser-host/package.json',
  'packages/contracts/package.json',
  'packages/design-tokens/package.json',
] as const;

const packages = await Promise.all(
  packageFiles.map(async path => {
    const value = JSON.parse(await readFile(path, 'utf8')) as { name?: string; version?: string };
    return { path, name: value.name ?? path, version: value.version };
  })
);

const expectedVersion = packages[0].version;
if (!expectedVersion || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(expectedVersion)) {
  throw new Error(`Invalid root version: ${expectedVersion ?? '<missing>'}`);
}

const mismatches = packages.filter(item => item.version !== expectedVersion);
if (mismatches.length > 0) {
  const details = packages.map(item => `${item.path}: ${item.version ?? '<missing>'}`).join('\n');
  throw new Error(`Workspace release versions must match:\n${details}`);
}

const tagArgument = process.argv.find(argument => argument.startsWith('--tag='));
const tag = tagArgument?.slice('--tag='.length) || process.env.GITHUB_REF_NAME;
if (tag && tag !== `v${expectedVersion}`) {
  throw new Error(`Release tag ${tag} does not match package version v${expectedVersion}`);
}

console.log(`Release version verified: v${expectedVersion}`);
