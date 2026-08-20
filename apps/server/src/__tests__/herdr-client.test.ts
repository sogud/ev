import { chmodSync, mkdirSync, mkdtempSync, renameSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HerdrClient } from '../herdr/herdr-client';

/**
 * fake-herdr injection: every mode is a small node script with a shebang; the
 * client execs it like the real CLI. Modes cover the three pipeline states —
 * available / unavailable (error envelope or missing binary) / timeout — plus
 * malformed-output tolerance.
 */

const FIXTURE_WORKSPACES = [
  {
    workspace_id: 'w1',
    label: 'alpha',
    number: 1,
    focused: true,
    tab_count: 2,
    pane_count: 4,
    agent_status: 'working',
    active_tab_id: 'w1:t1',
  },
  {
    workspace_id: 'w2',
    number: 2,
    focused: false,
    tab_count: 1,
    pane_count: 1,
    agent_status: 'idle',
    active_tab_id: 'w2:t9',
  },
];

const FIXTURE_TABS: Record<string, unknown[]> = {
  w1: [
    {
      tab_id: 'w1:t1',
      workspace_id: 'w1',
      label: 'main',
      number: 1,
      focused: true,
      pane_count: 2,
      agent_status: 'working',
    },
    {
      tab_id: 'w1:t2',
      workspace_id: 'w1',
      label: 'side',
      number: 2,
      focused: false,
      pane_count: 2,
      agent_status: 'idle',
    },
  ],
  w2: [
    {
      tab_id: 'w2:t9',
      workspace_id: 'w2',
      label: 'solo',
      number: 1,
      focused: true,
      pane_count: 1,
      agent_status: 'idle',
    },
  ],
};

const FIXTURE_PANES: Record<string, unknown[]> = {
  w1: [
    {
      pane_id: 'w1:p1',
      workspace_id: 'w1',
      tab_id: 'w1:t1',
      agent: 'pi',
      agent_status: 'working',
      cwd: '/tmp/a',
      terminal_title_stripped: 'π - main',
    },
    {
      pane_id: 'w1:p2',
      workspace_id: 'w1',
      tab_id: 'w1:t1',
      agent: 'codex',
      agent_status: 'blocked',
      cwd: '/tmp/b',
    },
    {
      pane_id: 'w1:p3',
      workspace_id: 'w1',
      tab_id: 'w1:t2',
      agent_status: 'unknown',
      cwd: '/tmp/c',
    },
    {
      pane_id: 'w1:p4',
      workspace_id: 'w1',
      tab_id: 'w1:t2',
      agent: 'qoder',
      agent_status: 'something-weird',
      cwd: '/tmp/d',
    },
  ],
  w2: [
    {
      pane_id: 'w2:p1',
      workspace_id: 'w2',
      tab_id: 'w2:t9',
      agent: 'pi',
      agent_status: 'idle',
      cwd: '/tmp/e',
    },
  ],
};

function fakeScript(mode: string): string {
  const fixture = `
const WORKSPACES = ${JSON.stringify(FIXTURE_WORKSPACES)};
const TABS = ${JSON.stringify(FIXTURE_TABS)};
const PANES = ${JSON.stringify(FIXTURE_PANES)};
const args = process.argv.slice(2);
const [command, subcommand, ...rest] = args;
const workspaceFlag = args.indexOf('--workspace');
const workspaceId = workspaceFlag >= 0 ? args[workspaceFlag + 1] : undefined;
const out = result => console.log(JSON.stringify({ id: 'fake', result }));
const fail = (code, message) => {
  console.log(JSON.stringify({ id: 'fake', error: { code, message } }));
  process.exit(1);
};
`;
  const dispatch = `
if (command === 'workspace' && subcommand === 'list') {
  out({ type: 'workspace_list', workspaces: WORKSPACES });
} else if (command === 'tab' && subcommand === 'list') {
  out({ type: 'tab_list', tabs: TABS[workspaceId] ?? [] });
} else if (command === 'pane' && subcommand === 'list') {
  ${mode === 'mixed' ? "console.log('not json at all');" : 'out({ type: "pane_list", panes: PANES[workspaceId] ?? [] });'}
} else if (command === 'agent' && subcommand === 'get') {
  out({ type: 'agent_info', agent: { pane_id: rest[0], name: 'fleet-test', agent: 'pi', agent_status: 'working', cwd: '/tmp/a' } });
} else if (command === 'pane' && subcommand === 'read') {
  console.log('line1\\nline2\\n');
} else if (command === 'agent' && subcommand === 'focus') {
  out({ type: 'agent_info', agent: { pane_id: rest[0] } });
} else {
  fail('unknown_command', 'fake herdr does not know this command');
}
`;
  switch (mode) {
    case 'ok':
    case 'mixed':
      return fixture + dispatch;
    case 'error':
      return "console.log(JSON.stringify({ id: 'fake', error: { code: 'server_down', message: 'no herdr server' } })); process.exit(1);";
    case 'sleep':
      return 'setTimeout(() => {}, 30_000);';
    case 'garbage':
      return "console.log('this is not json');";
    case 'malformed':
      return "console.log(JSON.stringify({ id: 'fake', result: { workspaces: 'not-an-array' } }));";
    default:
      throw new Error(`unknown fake herdr mode: ${mode}`);
  }
}

let fakeDir: string;
const fakes = new Map<string, string>();

function fakePath(mode: string): string {
  const cached = fakes.get(mode);
  if (cached) return cached;
  const file = join(fakeDir, `herdr-${mode}`);
  writeFileSync(file, `#!/usr/bin/env node\n${fakeScript(mode)}\n`);
  chmodSync(file, 0o755);
  fakes.set(mode, file);
  return file;
}

beforeAll(() => {
  fakeDir = mkdtempSync(join(tmpdir(), 'ev-fake-herdr-'));
  mkdirSync(join(homedir(), '.Trash'), { recursive: true });
});

afterAll(() => {
  // Repo red line: never rm — move the temp dir into the Trash.
  renameSync(fakeDir, join(homedir(), '.Trash', `ev-fake-herdr-${Date.now()}`));
});

describe('HerdrClient: available (fake herdr ok)', () => {
  const client = (): HerdrClient => new HerdrClient({ herdrPath: fakePath('ok') });

  it('probe succeeds', async () => {
    expect(await client().probe()).toBe(true);
  });

  it('listFleet assembles the workspace/tab/pane/agent tree', async () => {
    const snapshot = await client().listFleet();
    expect(snapshot).not.toBeNull();
    expect(snapshot?.available).toBe(true);
    expect(snapshot?.workspaces.map(workspace => workspace.workspaceId)).toEqual(['w1', 'w2']);

    const alpha = snapshot?.workspaces[0];
    expect(alpha?.name).toBe('alpha');
    expect(alpha?.tabs.map(tab => tab.tabId)).toEqual(['w1:t1', 'w1:t2']);

    const main = alpha?.tabs[0];
    expect(main?.label).toBe('main');
    expect(main?.panes.map(pane => pane.paneId)).toEqual(['w1:p1', 'w1:p2']);

    const piPane = main?.panes[0];
    expect(piPane).toMatchObject({
      title: 'π - main',
      cwd: '/tmp/a',
      agent: { name: 'pi', kind: 'pi', status: 'working' },
    });
    expect(main?.panes[1].agent?.status).toBe('blocked');

    const side = alpha?.tabs[1];
    // Pane without an agent stays agent-less; unknown statuses normalize.
    expect(side?.panes[0].agent).toBeUndefined();
    expect(side?.panes[1].agent).toMatchObject({ kind: 'qoder', status: 'unknown' });

    // Workspace without a label keeps name undefined.
    expect(snapshot?.workspaces[1].name).toBeUndefined();
    expect(snapshot?.workspaces[1].tabs[0].panes[0].paneId).toBe('w2:p1');
  });

  it('getAgent maps the agent info', async () => {
    expect(await client().getAgent('w1:p1')).toEqual({
      name: 'fleet-test',
      kind: 'pi',
      status: 'working',
      cwd: '/tmp/a',
      paneId: 'w1:p1',
    });
  });

  it('readPane returns raw terminal text without trailing whitespace', async () => {
    expect(await client().readPane('w1:p1')).toBe('line1\nline2');
  });

  it('focusPane resolves true on a success envelope', async () => {
    expect(await client().focusPane('w1:p1')).toBe(true);
  });

  it('rejects malformed pane ids without shelling out', async () => {
    expect(await client().getAgent('$(rm -rf /)')).toBeNull();
    expect(await client().readPane('')).toBeNull();
    expect(await client().focusPane('a b')).toBe(false);
  });
});

describe('HerdrClient: unavailable', () => {
  it('missing binary degrades on every call', async () => {
    const client = new HerdrClient({ herdrPath: join(fakeDir, 'does-not-exist') });
    expect(await client.probe()).toBe(false);
    expect(await client.listFleet()).toBeNull();
    expect(await client.getAgent('w1:p1')).toBeNull();
    expect(await client.readPane('w1:p1')).toBeNull();
    expect(await client.focusPane('w1:p1')).toBe(false);
  });

  it('error envelopes (non-zero exit) degrade on every call', async () => {
    const client = new HerdrClient({ herdrPath: fakePath('error') });
    expect(await client.probe()).toBe(false);
    expect(await client.listFleet()).toBeNull();
    expect(await client.getAgent('w1:p1')).toBeNull();
    expect(await client.focusPane('w1:p1')).toBe(false);
  });
});

describe('HerdrClient: timeout', () => {
  it('probe gives up within its timeout and resolves false', async () => {
    const client = new HerdrClient({ herdrPath: fakePath('sleep'), probeTimeoutMs: 300 });
    const startedAt = Date.now();
    expect(await client.probe()).toBe(false);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  it('listFleet times out to null', async () => {
    const client = new HerdrClient({ herdrPath: fakePath('sleep'), commandTimeoutMs: 300 });
    expect(await client.listFleet()).toBeNull();
  });
});

describe('HerdrClient: untrusted output tolerance', () => {
  it('garbage stdout never throws', async () => {
    const client = new HerdrClient({ herdrPath: fakePath('garbage') });
    expect(await client.probe()).toBe(false);
    expect(await client.listFleet()).toBeNull();
  });

  it('wrongly shaped envelopes degrade to unavailable', async () => {
    const client = new HerdrClient({ herdrPath: fakePath('malformed') });
    expect(await client.probe()).toBe(false);
    expect(await client.listFleet()).toBeNull();
  });

  it('a broken pane list only degrades its own workspace', async () => {
    const client = new HerdrClient({ herdrPath: fakePath('mixed') });
    const snapshot = await client.listFleet();
    expect(snapshot).not.toBeNull();
    expect(snapshot?.workspaces[0].tabs.map(tab => tab.panes)).toEqual([[], []]);
    expect(snapshot?.workspaces[1].tabs[0].panes).toEqual([]);
  });
});
