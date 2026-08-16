import { createMDX } from 'fumadocs-mdx/next';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const withMDX = createMDX();

const siteRoot = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  // The site is a standalone build; pin the workspace root so Next does not
  // infer it from the surrounding monorepo lockfile.
  outputFileTracingRoot: siteRoot,
};

export default withMDX(config);
