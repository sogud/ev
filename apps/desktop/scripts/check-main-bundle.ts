import { readFile } from 'node:fs/promises';
import path from 'node:path';

const bundlePath = path.resolve(import.meta.dirname, '../dist-electron/main/index.js');
const bundle = await readFile(bundlePath, 'utf8');
const externalWorkspaceImports = [
  ...bundle.matchAll(/(?:from\s+|import\s*(?:\(\s*)?)["'](@ev\/[^"']+)["']/g),
].map(match => match[1]);

if (externalWorkspaceImports.length > 0) {
  throw new Error(
    `Desktop main bundle contains uncompiled workspace imports: ${externalWorkspaceImports.join(', ')}`
  );
}

console.log('Desktop main bundle contains no external @ev workspace imports.');
