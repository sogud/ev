import { mkdir, mkdtemp, readFile, rm, writeFile, symlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { workspaceCommand } from './workspace-cli';

let directory: string;
let config: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'ev-workspace-test-'));
  vi.stubEnv('EV_HOME', path.join(directory, 'ev-home'));
  vi.spyOn(os, 'homedir').mockReturnValue(directory);
  config = path.join(directory, 'workspaces.json');
  await mkdir(path.join(directory, 'writing'));
  await mkdir(path.join(directory, 'vault'));
  await writeFile(
    config,
    JSON.stringify({
      workspaces: {
        creator: {
          root: './writing',
          knowledgeRoot: './vault',
          skillsDir: './writing/tools',
          skills: {},
        },
      },
    })
  );
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

it('resolves workspace and external knowledge paths from the config, not the caller cwd', async () => {
  const result = await workspaceCommand(['workspace', 'context', 'creator', '--config', config]);
  expect(result.data).toMatchObject({
    root: path.join(directory, 'writing'),
    knowledgeRoot: path.join(directory, 'vault'),
  });
  expect(await readFile(config, 'utf8')).toContain('./writing');
});

it('returns only entry paths for the selected workspace and does not read MCP contents', async () => {
  const settings = JSON.parse(await readFile(config, 'utf8'));
  settings.workspaces.creator.entries = ['./writing/AGENTS.md'];
  settings.workspaces.creator.mcpFiles = ['./writing/mcp.json'];
  await writeFile(config, JSON.stringify(settings));
  await writeFile(path.join(directory, 'writing/AGENTS.md'), '# Writing');
  await writeFile(path.join(directory, 'writing/mcp.json'), 'private credential');
  const result = await workspaceCommand(['workspace', 'context', 'creator', '--config', config]);
  expect(result.data).toMatchObject({
    root: path.join(directory, 'writing'),
    entryDocuments: [path.join(directory, 'writing/AGENTS.md')],
    mcpFiles: [path.join(directory, 'writing/mcp.json')],
  });
  expect(JSON.stringify(result.data)).not.toContain('private credential');
});

it('reuses manifest routes and project skill lists, including an explicit repository target', async () => {
  await mkdir(path.join(directory, 'writing/.agents/skills/writer'), { recursive: true });
  await writeFile(path.join(directory, 'writing/.agents/skills/writer/SKILL.md'), '# Writer');
  await writeFile(path.join(directory, 'writing/AGENTS.md'), '# Rules');
  await writeFile(path.join(directory, 'AGENTS.md'), '# Root');
  await writeFile(
    path.join(directory, 'writing/project.json'),
    JSON.stringify({
      name: 'creator',
      skills: { installed: ['writer'] },
      paths: { knowledge: '../vault' },
    })
  );
  await writeFile(
    config,
    JSON.stringify({
      manifestVersion: 1,
      workspace: {
        name: 'personal',
        knowledgeRoot: './vault',
        projectRoots: ['./writing'],
        entries: { rules: 'AGENTS.md' },
        routes: {
          workspace: { entries: ['AGENTS.md'] },
          creator: { base: 'workspace', target: 'creator' },
          development: { base: 'workspace' },
        },
      },
      repos: [{ name: 'ev', path: 'writing' }],
    })
  );
  const result = await workspaceCommand(['workspace', 'context', 'creator', '--config', config]);
  expect(result.data).toMatchObject({
    root: path.join(directory, 'writing'),
    knowledgeRoot: path.join(directory, 'vault'),
    skills: { writer: path.join(directory, 'writing/.agents/skills/writer') },
  });
  expect(result.data).toMatchObject({
    entryDocuments: expect.arrayContaining([
      path.join(directory, 'AGENTS.md'),
      path.join(directory, 'writing/AGENTS.md'),
    ]),
  });
  expect(
    (
      await workspaceCommand([
        'workspace',
        'context',
        'development',
        '--target',
        'ev',
        '--config',
        config,
      ])
    ).data
  ).toMatchObject({ root: path.join(directory, 'writing') });
  await expect(
    workspaceCommand(['workspace', 'context', 'no-such-route', '--config', config])
  ).rejects.toThrow(/Unknown/);
});

it('finds the nearest manifest from a nested directory and rejects cyclic routes', async () => {
  const manifest = path.join(directory, 'manifest.json');
  const settings = {
    manifestVersion: 1,
    workspace: {
      name: 'root',
      projectRoots: ['writing'],
      routes: { creator: { target: 'creator' } },
    },
    repos: [],
  };
  await writeFile(
    path.join(directory, 'writing/project.json'),
    JSON.stringify({ name: 'creator' })
  );
  await writeFile(manifest, JSON.stringify(settings));
  const nested = path.join(directory, 'writing/drafts');
  await mkdir(nested);
  vi.stubEnv('EV_WORKSPACE_CONFIG', '');
  vi.spyOn(process, 'cwd').mockReturnValue(nested);
  expect((await workspaceCommand(['workspace', 'context'])).data).toMatchObject({
    name: 'creator',
    root: path.join(directory, 'writing'),
    configPath: manifest,
  });
  await writeFile(
    manifest,
    JSON.stringify({
      ...settings,
      workspace: {
        ...settings.workspace,
        routes: { first: { base: 'second' }, second: { base: 'first' } },
      },
    })
  );
  await expect(workspaceCommand(['workspace', 'context'])).rejects.toThrow(/cycle/);
});

it('clears inherited skills when a route explicitly narrows its candidates', async () => {
  await writeFile(
    config,
    JSON.stringify({
      manifestVersion: 1,
      workspace: {
        name: 'root',
        routes: { parent: { skills: ['writer'] }, child: { base: 'parent', skills: [] } },
      },
      repos: [],
    })
  );
  expect(
    (await workspaceCommand(['workspace', 'context', 'child', '--config', config])).data
  ).toHaveProperty('skills', {});
});

it('selects only the target context when no task route was explicitly requested', async () => {
  const settings = JSON.parse(await readFile(config, 'utf8'));
  settings.workspaces.code = { root: './vault', knowledgeRoot: './vault', entries: [], skills: {} };
  settings.workspaces.creator.entries = ['./writing/AGENTS.md'];
  await writeFile(config, JSON.stringify(settings));
  vi.spyOn(process, 'cwd').mockReturnValue(path.join(directory, 'writing'));
  expect(
    (await workspaceCommand(['workspace', 'context', '--target', 'code', '--config', config])).data
  ).toMatchObject({ name: 'code', root: path.join(directory, 'vault'), entryDocuments: [] });
});

it('requires an explicit workspace for skill copy instead of guessing a write destination', async () => {
  vi.spyOn(process, 'cwd').mockReturnValue(path.join(directory, 'writing'));
  await expect(
    workspaceCommand(['workspace', 'skills', 'copy', 'writer', '--config', config])
  ).rejects.toThrow(/--workspace/);
});

it('copies a complete skill, keeps the source, previews changes, and refuses conflicting files', async () => {
  const source = path.join(directory, 'library', 'writing');
  await mkdir(path.join(source, 'references'), { recursive: true });
  await writeFile(path.join(source, 'SKILL.md'), '---\nname: writing\ndescription: Write\n---\n');
  await writeFile(path.join(source, 'references', 'guide.md'), 'Guide');
  const settings = JSON.parse(await readFile(config, 'utf8'));
  settings.workspaces.creator.skills.writing = './library/writing';
  await writeFile(config, JSON.stringify(settings));
  const args = [
    'workspace',
    'skills',
    'copy',
    'writing',
    '--workspace',
    'creator',
    '--config',
    config,
  ];
  expect((await workspaceCommand([...args, '--dry-run'])).data).toMatchObject({
    status: 'preview',
  });
  await expect(readFile(path.join(directory, 'writing/tools/writing/SKILL.md'))).rejects.toThrow();
  expect((await workspaceCommand(args)).data).toMatchObject({ status: 'copied' });
  expect(
    await readFile(path.join(directory, 'writing/tools/writing/references/guide.md'), 'utf8')
  ).toBe('Guide');
  expect(await readFile(path.join(source, 'SKILL.md'), 'utf8')).toContain('writing');
  expect((await workspaceCommand(args)).data).toMatchObject({ status: 'unchanged' });
  await writeFile(path.join(directory, 'writing/tools/writing/SKILL.md'), 'Local edits');
  await expect(workspaceCommand(args)).rejects.toThrow(/conflict/i);
  expect(await readFile(path.join(directory, 'writing/tools/writing/SKILL.md'), 'utf8')).toBe(
    'Local edits'
  );
});

it('rejects a skill with escaping links and a destination outside the workspace', async () => {
  const source = path.join(directory, 'library');
  await mkdir(source);
  await writeFile(path.join(source, 'SKILL.md'), '# Skill');
  await symlink(config, path.join(source, 'secret-link'));
  const settings = JSON.parse(await readFile(config, 'utf8'));
  settings.workspaces.creator.skills.writing = './library';
  await writeFile(config, JSON.stringify(settings));
  const args = [
    'workspace',
    'skills',
    'copy',
    'writing',
    '--workspace',
    'creator',
    '--config',
    config,
  ];
  await expect(workspaceCommand(args)).rejects.toThrow(/escapes/);
  settings.workspaces.creator.skillsDir = './vault';
  await writeFile(config, JSON.stringify(settings));
  await expect(workspaceCommand(args)).rejects.toThrow(/inside/);
});

it('handles absolute paths, missing directories, and absent config without creating them', async () => {
  const settings = JSON.parse(await readFile(config, 'utf8'));
  settings.workspaces.creator.root = path.join(directory, 'not-created');
  await writeFile(config, JSON.stringify(settings));
  const result = await workspaceCommand(['workspace', 'context', 'creator', '--config', config]);
  expect(result.exitCode).toBe(1);
  expect(result.data).toMatchObject({ warnings: [expect.stringContaining('not-created')] });
  vi.stubEnv('EV_WORKSPACE_CONFIG', '');
  vi.spyOn(process, 'cwd').mockReturnValue(directory);
  await expect(workspaceCommand(['workspace', 'context'])).rejects.toThrow(/--config/);
});

it('exposes workspace context and rejects removed commands through the actual CLI without a server', async () => {
  const outfile = path.join(directory, 'ev.mjs');
  await build({
    entryPoints: [path.resolve(import.meta.dirname, 'cli.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile,
    banner: {
      js: 'import {createRequire} from "node:module"; const require=createRequire(import.meta.url);',
    },
  });
  const run = (args: string[]) =>
    promisify(execFile)(process.execPath, [outfile, ...args], {
      cwd: directory,
      env: {
        ...process.env,
        EV_HOME: path.join(directory, 'ev-home'),
        EV_WORKSPACE_CONFIG: config,
      },
    });
  expect((await run(['workspace', '--help'])).stdout).toContain('skills copy');
  const result = await run(['workspace', 'context', 'creator']);
  expect(JSON.parse(result.stdout)).toMatchObject({
    name: 'creator',
    root: path.join(directory, 'writing'),
  });
  await expect(run(['knowledge', 'read', 'note.md'])).rejects.toThrow();
  await expect(run(['workspace', 'skills', 'move', 'writer'])).rejects.toThrow();
  await expect(readFile(path.join(directory, 'ev-home/run/server.json'))).rejects.toThrow();
});
