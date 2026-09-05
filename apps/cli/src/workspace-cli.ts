import { cp, lstat, mkdir, readFile, readdir, readlink, realpath, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

export class WorkspaceError extends Error {}

export const workspaceUsage = `Usage:
  ev workspace context [name] [--target <name>] [--config <file>]
  ev workspace skills copy <id> --workspace <name> --config <file> [--dry-run]

--config can also be set with EV_WORKSPACE_CONFIG. JSON output is the default.
All configured paths resolve relative to the config file. No Agent or server is started.
Without --config, context finds the nearest ancestor manifest.json with workspace settings.
Skills are copied without overwriting or removing sources. Use Git and QMD directly.`;

type RecordValue = Record<string, unknown>;
function record(value: unknown, label: string): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new WorkspaceError(`${label} must be an object`);
  }
  return value as RecordValue;
}
function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim())
    throw new WorkspaceError(`${label} must be a nonempty string`);
  return value;
}

interface Workspace {
  name: string;
  configPath: string;
  root: string;
  knowledgeRoot?: string;
  skillsDir?: string;
  skills: Record<string, string>;
  mcpFiles: string[];
  entryDocuments: string[];
  onDemand: string[];
  selectable?: boolean;
  freshness?: string;
}

async function loadConfig(configPath: string): Promise<Workspace[]> {
  const config = record(JSON.parse(await readFile(configPath, 'utf8')), 'config');
  if (config.manifestVersion === 1) return loadManifest(config, configPath);
  const base = path.dirname(configPath);
  const resolve = (value: unknown, label: string) => path.resolve(base, text(value, label));
  return Object.entries(record(config.workspaces, 'workspaces')).map(([name, raw]) => {
    const value = record(raw, `workspace ${name}`);
    const skills = Object.fromEntries(
      Object.entries(record(value.skills ?? {}, 'skills')).map(([id, source]) => [
        id,
        resolve(source, `skill ${id}`),
      ])
    );
    if (value.mcpFiles !== undefined && !Array.isArray(value.mcpFiles))
      throw new WorkspaceError('mcpFiles must be an array');
    return {
      name,
      configPath,
      root: resolve(value.root, 'root'),
      knowledgeRoot:
        value.knowledgeRoot === undefined
          ? undefined
          : resolve(value.knowledgeRoot, 'knowledgeRoot'),
      skillsDir: value.skillsDir === undefined ? undefined : resolve(value.skillsDir, 'skillsDir'),
      skills,
      entryDocuments: stringArray(value.entries, 'entries').map(item => resolve(item, 'entry')),
      onDemand: stringArray(value.onDemand, 'onDemand').map(item => resolve(item, 'onDemand')),
      mcpFiles: ((value.mcpFiles as unknown[] | undefined) ?? []).map(item =>
        resolve(item, 'mcpFiles entry')
      ),
    };
  });
}

async function optionalJson(location: string): Promise<RecordValue | undefined> {
  try {
    return record(JSON.parse(await readFile(location, 'utf8')), location);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function discoverConfig(): Promise<string> {
  let directory = process.cwd();
  while (true) {
    const candidate = path.join(directory, 'manifest.json');
    const config = await optionalJson(candidate);
    if (config && (config.manifestVersion === 1 || config.workspaces)) return candidate;
    const parent = path.dirname(directory);
    if (parent === directory)
      throw new WorkspaceError(
        'No workspace manifest found; specify --config <file> or EV_WORKSPACE_CONFIG'
      );
    directory = parent;
  }
}

// Compatibility is limited to context metadata; no Python, Git or platform configuration runs.
async function loadManifest(config: RecordValue, configPath: string): Promise<Workspace[]> {
  const base = path.dirname(configPath);
  const settings = record(config.workspace, 'workspace');
  const resolve = (value: string) => path.resolve(base, value);
  const paths = (value: unknown, label: string) => stringArray(value, label).map(resolve);
  const baseEntries = Object.values(record(settings.entries ?? {}, 'workspace.entries')).map(
    value => resolve(text(value, 'entry'))
  );
  const root: Workspace = {
    name: text(settings.name, 'workspace.name'),
    configPath,
    root: base,
    knowledgeRoot:
      settings.knowledgeRoot === undefined
        ? undefined
        : resolve(text(settings.knowledgeRoot, 'knowledgeRoot')),
    skillsDir:
      settings.skillsDir === undefined ? undefined : resolve(text(settings.skillsDir, 'skillsDir')),
    skills: {},
    mcpFiles: [],
    entryDocuments: baseEntries,
    onDemand: [],
  };
  const workspaces = new Map<string, Workspace>([[root.name, root]]);
  const sharedRoots = paths(settings.skillRoots, 'skillRoots');
  const skillSources = new Map<string, string>();
  for (const directory of sharedRoots) {
    // Search direct skills and one category level, not arbitrary repository trees.
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(error => {
      if (error.code === 'ENOENT') return [];
      throw error;
    })) {
      const candidate = path.join(directory, entry.name);
      if ((await stat(path.join(candidate, 'SKILL.md')).catch(() => undefined))?.isFile()) {
        if (!skillSources.has(entry.name)) skillSources.set(entry.name, candidate);
      } else if (entry.isDirectory()) {
        for (const child of await readdir(candidate)) {
          const source = path.join(candidate, child);
          if (
            (await stat(path.join(source, 'SKILL.md')).catch(() => undefined))?.isFile() &&
            !skillSources.has(child)
          )
            skillSources.set(child, source);
        }
      }
    }
  }
  const resolveSkills = async (
    ids: string[],
    directory: string
  ): Promise<Record<string, string>> => {
    const result: Record<string, string> = {};
    for (const id of ids) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id))
        throw new WorkspaceError(`Invalid skill id: ${id}`);
      const local = path.join(directory, '.agents/skills', id);
      result[id] = (await stat(path.join(local, 'SKILL.md')).catch(() => undefined))?.isFile()
        ? local
        : (skillSources.get(id) ?? local);
    }
    return result;
  };
  const projectDirectories = new Set<string>();
  if (config.repos !== undefined && !Array.isArray(config.repos))
    throw new WorkspaceError('repos must be an array');
  for (const raw of (config.repos ?? []) as unknown[]) {
    const repo = record(raw, 'repo');
    const directory = resolve(text(repo.path, 'repo.path'));
    const name = text(repo.name, 'repo.name');
    workspaces.set(name, {
      ...root,
      name,
      root: directory,
      skillsDir: path.join(directory, '.agents/skills'),
    });
    projectDirectories.add(directory);
  }
  for (const directory of paths(settings.projectRoots, 'projectRoots')) {
    projectDirectories.add(directory);
    for (const child of await readdir(directory, { withFileTypes: true }).catch(error => {
      if (error.code === 'ENOENT') return [];
      throw error;
    }))
      if (child.isDirectory()) projectDirectories.add(path.join(directory, child.name));
  }
  for (const directory of projectDirectories) {
    const project = await optionalJson(path.join(directory, 'project.json'));
    const existing = [...workspaces.values()].find(item => item.root === directory);
    if (!project && !existing) continue;
    const name = project ? text(project.name, 'project.name') : existing!.name;
    const projectSkills = record(project?.skills ?? {}, 'project.skills');
    const projectPaths = record(project?.paths ?? {}, 'project.paths');
    const entryDocuments = [...baseEntries];
    for (const filename of ['AGENTS.md', 'CLAUDE.md', 'README.md', 'project.json']) {
      const location = path.join(directory, filename);
      if ((await stat(location).catch(() => undefined))?.isFile()) entryDocuments.push(location);
    }
    const mcp = path.join(directory, '.mcp.json');
    const workspace: Workspace = {
      ...root,
      name,
      root: directory,
      skillsDir: path.join(directory, '.agents/skills'),
      entryDocuments,
      knowledgeRoot:
        projectPaths.knowledge === undefined
          ? root.knowledgeRoot
          : path.resolve(directory, text(projectPaths.knowledge, 'project.paths.knowledge')),
      skills: await resolveSkills(
        [
          ...stringArray(projectSkills.installed, 'installed'),
          ...stringArray(projectSkills.shared, 'shared'),
        ],
        directory
      ),
      mcpFiles: (await stat(mcp).catch(() => undefined))?.isFile() ? [mcp] : [],
    };
    workspaces.set(name, workspace);
    if (existing && existing.name !== name)
      workspaces.set(existing.name, { ...workspace, name: existing.name });
  }
  const routes = record(settings.routes ?? {}, 'workspace.routes');
  const built = new Map<string, Workspace>();
  const buildRoute = async (name: string, chain: string[] = []): Promise<Workspace> => {
    if (built.has(name)) return built.get(name)!;
    if (chain.includes(name))
      throw new WorkspaceError(`Route cycle: ${[...chain, name].join(' -> ')}`);
    if (!Object.hasOwn(routes, name)) throw new WorkspaceError(`Unknown route: ${name}`);
    const route = record(routes[name], `route ${name}`);
    const parent =
      route.base === undefined
        ? root
        : await buildRoute(text(route.base, 'route.base'), [...chain, name]);
    const target =
      route.target === undefined ? undefined : workspaces.get(text(route.target, 'route.target'));
    if (route.target !== undefined && !target)
      throw new WorkspaceError(`Unknown route target: ${String(route.target)}`);
    const selected = target ?? parent;
    const result: Workspace = {
      ...selected,
      name,
      selectable: !!target,
      entryDocuments: [
        ...new Set([
          ...parent.entryDocuments,
          ...selected.entryDocuments,
          ...paths(route.entries, 'route.entries'),
        ]),
      ],
      onDemand: [...new Set([...parent.onDemand, ...paths(route.onDemand, 'route.onDemand')])],
      skills:
        route.skills === undefined
          ? { ...parent.skills, ...selected.skills }
          : await resolveSkills(stringArray(route.skills, 'route.skills'), selected.root),
      knowledgeRoot:
        route.knowledgeScope === undefined
          ? selected.knowledgeRoot
          : resolve(text(route.knowledgeScope, 'knowledgeScope')),
      freshness:
        route.freshness === undefined ? parent.freshness : text(route.freshness, 'freshness'),
    };
    built.set(name, result);
    return result;
  };
  for (const name of Object.keys(routes)) await buildRoute(name);
  for (const [name, workspace] of built) workspaces.set(name, workspace);
  return [...workspaces.values()];
}

export interface WorkspaceResult {
  data: unknown;
  exitCode: number;
}

function stringArray(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new WorkspaceError(`${label} must be an array`);
  return value.map(item => text(item, label));
}

export async function workspaceCommand(argv: string[]): Promise<WorkspaceResult> {
  const args: string[] = [];
  let configPath = process.env.EV_WORKSPACE_CONFIG;
  let workspaceName: string | undefined;
  let targetName: string | undefined;
  let dryRun = false;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--config' || arg === '--workspace' || arg === '--target') {
      const value = argv[++index];
      if (!value || value.startsWith('-')) throw new WorkspaceError(`${arg} requires a value`);
      if (arg === '--config') configPath = value;
      else if (arg === '--target') targetName = value;
      else workspaceName = value;
    } else if (arg === '--dry-run') dryRun = true;
    else if (arg === '--json') continue;
    else if (arg.startsWith('-')) throw new WorkspaceError(`Unknown option: ${arg}`);
    else args.push(arg);
  }
  const isContext = args[0] === 'workspace' && args[1] === 'context' && args.length <= 3;
  const isCopy =
    args[0] === 'workspace' && args[1] === 'skills' && args[2] === 'copy' && args.length === 4;
  if (!isContext && !isCopy)
    throw new WorkspaceError(`Unsupported workspace command: ${args.join(' ')}`);
  if (dryRun && !isCopy) throw new WorkspaceError('--dry-run only applies to skill copy');
  if (targetName && !isContext) throw new WorkspaceError('--target only applies to context');
  if (isCopy && !workspaceName) throw new WorkspaceError('Skill copy requires --workspace <name>');
  if (!configPath) configPath = await discoverConfig();
  const workspaces = await loadConfig(path.resolve(configPath));
  const name = workspaceName ?? (isContext ? args[2] : undefined);
  const selection = name ?? targetName;
  let workspace = selection
    ? workspaces.find(entry => entry.name === selection)
    : workspaces
        .filter(entry => entry.selectable !== false && inside(entry.root, process.cwd()))
        .sort((a, b) => b.root.length - a.root.length)[0];
  if (!workspace)
    throw new WorkspaceError(`Unknown or missing workspace: ${selection ?? '(specify a name)'}`);
  if (targetName && name) {
    const target = workspaces.find(entry => entry.name === targetName);
    if (!target) throw new WorkspaceError(`Unknown target: ${targetName}`);
    workspace = {
      ...workspace,
      root: target.root,
      skillsDir: target.skillsDir,
      mcpFiles: target.mcpFiles,
      entryDocuments: [...new Set([...workspace.entryDocuments, ...target.entryDocuments])],
      skills: { ...workspace.skills, ...target.skills },
    };
  }
  if (isCopy) return copySkill(workspace, args[3], dryRun);
  const warnings: string[] = [];
  for (const location of [workspace.root, workspace.knowledgeRoot].filter(
    (item): item is string => !!item
  )) {
    if (!(await stat(location).catch(() => undefined))?.isDirectory())
      warnings.push(`Missing directory: ${location}`);
  }
  for (const location of [
    ...workspace.entryDocuments,
    ...workspace.onDemand,
    ...Object.values(workspace.skills).map(source => path.join(source, 'SKILL.md')),
    ...workspace.mcpFiles,
  ]) {
    if (!(await stat(location).catch(() => undefined))?.isFile())
      warnings.push(`Missing file: ${location}`);
  }
  return {
    data: { ...workspace, availableWorkspaces: workspaces.map(entry => entry.name), warnings },
    exitCode: warnings.length ? 1 : 0,
  };
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === '' ||
    (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
  );
}

async function existingPath(location: string): Promise<string> {
  try {
    return await realpath(location);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const parent = path.dirname(location);
    if (parent === location) throw error;
    // A dangling link is not an available destination.
    if (await lstat(location).catch(() => undefined))
      throw new WorkspaceError(`Broken link: ${location}`);
    return path.join(await existingPath(parent), path.basename(location));
  }
}

async function skillInventory(root: string): Promise<string> {
  const entries: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const name of (await readdir(directory)).sort()) {
      const location = path.join(directory, name);
      const info = await lstat(location);
      const relative = path.relative(root, location);
      if (info.isSymbolicLink()) {
        const link = await readlink(location);
        if (path.isAbsolute(link) || !inside(root, await realpath(location)))
          throw new WorkspaceError(`Skill link escapes its directory: ${location}`);
        entries.push(`link:${relative}:${link}`);
      } else if (info.isDirectory()) {
        entries.push(`dir:${relative}`);
        await visit(location);
      } else if (info.isFile()) {
        entries.push(
          `file:${relative}:${info.mode & 0o777}:${createHash('sha256')
            .update(await readFile(location))
            .digest('hex')}`
        );
      } else throw new WorkspaceError(`Unsupported skill file: ${location}`);
    }
  }
  await visit(root);
  return JSON.stringify(entries);
}

async function copySkill(
  workspace: Workspace,
  id: string,
  dryRun: boolean
): Promise<WorkspaceResult> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id)) throw new WorkspaceError('Invalid skill id');
  const configuredSource = Object.hasOwn(workspace.skills, id) ? workspace.skills[id] : undefined;
  if (!configuredSource || !workspace.skillsDir)
    throw new WorkspaceError('Configure skills.<id> and skillsDir first');
  const root = await realpath(workspace.root);
  const source = await realpath(configuredSource);
  if (
    (
      await lstat(path.join(workspace.skillsDir, id)).catch(error => {
        if (error.code === 'ENOENT') return undefined;
        throw error;
      })
    )?.isSymbolicLink()
  )
    throw new WorkspaceError('Skill conflict: destination is a symlink');
  const target = await existingPath(path.join(workspace.skillsDir, id));
  if (!inside(root, target))
    throw new WorkspaceError('skillsDir must stay inside the workspace root');
  if (source !== target && (inside(source, target) || inside(target, source)))
    throw new WorkspaceError('Skill source and destination must not overlap');
  if (!(await stat(path.join(source, 'SKILL.md'))).isFile())
    throw new WorkspaceError('Skill requires SKILL.md');
  const inventory = await skillInventory(source);
  if (source === target) return { data: { status: 'unchanged', source, target }, exitCode: 0 };
  const occupied = await lstat(target).catch(error => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (occupied) {
    if (
      !occupied.isSymbolicLink() &&
      occupied.isDirectory() &&
      (await skillInventory(target)) === inventory
    ) {
      return { data: { status: 'unchanged', source, target }, exitCode: 0 };
    }
    throw new WorkspaceError(`Skill conflict; destination left unchanged: ${target}`);
  }
  if (dryRun)
    return { data: { status: 'preview', operation: 'copy', source, target }, exitCode: 0 };
  await mkdir(path.dirname(target), { recursive: true });
  // Exclusive reservation prevents simultaneous copies from merging or overwriting.
  await mkdir(target);
  try {
    for (const name of await readdir(source)) {
      await cp(path.join(source, name), path.join(target, name), {
        recursive: true,
        force: false,
        errorOnExist: true,
        verbatimSymlinks: true,
      });
    }
    if ((await skillInventory(target)) !== inventory)
      throw new Error('Copied files differ from the source snapshot');
  } catch (error) {
    throw new WorkspaceError(
      `Copy incomplete; source preserved, inspect ${target}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  return { data: { status: 'copied', source, target }, exitCode: 0 };
}
