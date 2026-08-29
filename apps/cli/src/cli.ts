#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import cliPackage from '../package.json' with { type: 'json' };
import {
  DEFAULT_BROWSER_PROFILE,
  ensureStandaloneHost,
  evHomeDirectory,
  listBrowserProfiles,
  normalizeBrowserProfile,
  runStandaloneHost,
  standaloneDiscoveryPath,
  stopStandaloneHost,
} from './standalone-host';
import {
  BrowserCommandSchema,
  BrowserControlResponseSchema,
  EV_PROTOCOL_VERSION,
  type BrowserHostControlCommand,
  type BrowserCommand,
} from '@ev/contracts';
import { CliError, isServerCliCommand, runServerCli } from './server-cli';

const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const MUTATING_BOOKMARK_ACTIONS = new Set<BrowserCommand['action']>([
  'bookmarks.create',
  'bookmarks.update',
  'bookmarks.move',
  'bookmarks.remove',
  'bookmarks.removeTree',
  'bookmarks.restore',
]);

interface DiscoveryFile {
  protocolVersion: number;
  socketPath: string;
  tokenPath: string;
}

interface ParsedArguments {
  action: string;
  payload: Record<string, unknown>;
  timeoutMs: number;
  compact: boolean;
  outputPath?: string;
  profile: string;
}

class UsageError extends Error {}

function usage(): string {
  return [
    'usage:',
    '  ev browser <action> [--payload <json> | --payload-file <path>]',
    '                    [--timeout <seconds>] [--output <path>] [--compact]',
    '                    [--profile <name>]   per-browser Host profile (default: default)',
    '  ev browser profile list         show Host profiles and their paired browsers',
    '  ev browser pairing list         show pairing requests waiting for approval',
    '  ev browser pairing approve|reject <browser-id> [--profile <name>]',
    '  ev browser check',
    '  ev browser oneShot --payload \'{"url":"https://example.com","command":{"action":"page.snapshot"}}\'',
    '  ev browser session.create --payload \'{"url":"https://example.com"}\'',
    '  ev browser recipe.list',
    '  ev status                     LAN/Tailscale URLs + masked-token hint',
    '  ev remote on|off|status',
    '  ev token create --tier observer|operator | list | revoke <id>',
    '  ev server start|stop|restart|status|logs / ev task … / ev runtime …',
    '',
    'examples:',
    '  ev browser host [serve|stop] / ev browser profile list',
    '  ev browser pairing list / ev browser pairing approve <browser-id>',
    '  ev browser oneShot --payload \'{"url":"https://example.com","command":{"action":"page.snapshot","mode":"interactive"}}\'',
    '  ev browser session.create --payload \'{"url":"https://example.com"}\' --profile edge',
    '  ev browser session.command --payload \'{"sessionId":"UUID","command":{"action":"page.snapshot"}}\'',
    '  ev browser history.search --payload \'{"text":"EV","maxResults":20}\'',
    '  ev browser downloads.status --payload \'{"downloadId":"chrome:42"}\'',
    '  ev browser bookmarks.search --payload \'{"query":"EV"}\'',
    '  ev browser bookmarks.export --output ./bookmarks.json',
    '  ev browser session.list',
    '  ev browser recipe.run --payload-file <request.json>',
  ].join('\n');
}

function normalizeBrowserAction(action: string): string {
  if (action === 'check') return 'browser.capabilities';
  if (action === 'run') return 'browser.run';
  if (action === 'oneShot' || action === 'oneshot') return 'browser.oneShot';
  if (action.startsWith('session.') || action.startsWith('recipe.')) {
    return `browser.${action}`;
  }
  return action;
}

function extractHostProfile(argv: string[]): string {
  const index = argv.indexOf('--profile');
  if (index === -1) return DEFAULT_BROWSER_PROFILE;
  const value = argv[index + 1];
  if (!value) throw new UsageError('--profile is missing its name');
  return normalizeBrowserProfile(value);
}

async function parseArguments(argv: string[]): Promise<ParsedArguments> {
  if (argv[0] !== 'browser') throw new UsageError('only ev browser commands are supported here');
  const action = argv[1];
  if (!action || action === '--help' || action === '-h') throw new UsageError(usage());

  let payload: Record<string, unknown> = {};
  let payloadFile: string | undefined;
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  let compact = false;
  let outputPath: string | undefined;
  let profile = DEFAULT_BROWSER_PROFILE;

  for (let index = 2; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--profile') {
      const value = argv[++index];
      if (!value) throw new UsageError('--profile is missing its name');
      profile = normalizeBrowserProfile(value);
      continue;
    }
    if (argument === '--payload') {
      const value = argv[++index];
      if (!value) throw new UsageError('--payload is missing its JSON argument');
      try {
        const decoded = JSON.parse(value);
        if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
          throw new Error('payload must be an object');
        }
        payload = decoded as Record<string, unknown>;
      } catch {
        throw new UsageError('--payload must be a JSON object');
      }
      continue;
    }
    if (argument === '--payload-file') {
      payloadFile = argv[++index];
      if (!payloadFile) throw new UsageError('--payload-file is missing its file path');
      continue;
    }
    if (argument === '--timeout') {
      const value = Number(argv[++index]);
      if (!Number.isFinite(value) || value <= 0 || value > 300) {
        throw new UsageError('--timeout must be a number between 0 and 300 seconds');
      }
      timeoutMs = value * 1000;
      continue;
    }
    if (argument === '--output') {
      outputPath = argv[++index];
      if (!outputPath) throw new UsageError('--output is missing its file path');
      continue;
    }
    if (argument === '--compact') {
      compact = true;
      continue;
    }
    throw new UsageError(`unknown argument: ${argument}`);
  }

  if (payloadFile) {
    try {
      const decoded = JSON.parse(await readFile(payloadFile, 'utf8'));
      if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
        throw new Error('payload must be an object');
      }
      payload = decoded as Record<string, unknown>;
    } catch (error) {
      throw new UsageError(
        `cannot read payload file: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  return {
    action: normalizeBrowserAction(action),
    payload,
    timeoutMs,
    compact,
    outputPath,
    profile,
  };
}

function requiresBrowserSession(action: BrowserCommand['action']): boolean {
  return (
    action === 'browser.run' ||
    action === 'sessions.restore' ||
    action.startsWith('page.') ||
    action.startsWith('tabs.') ||
    action.startsWith('windows.') ||
    action.startsWith('tabGroups.') ||
    action.startsWith('zoom.')
  );
}

// Page actions are only valid inside browser.oneShot / browser.session.command.
// Agents routinely try them top-level or without the page. prefix; give them
// the exact correction instead of a dead-end error.
const PAGE_ACTION_HINTS: Record<string, string> = {
  snapshot: 'page.snapshot returns element refs; use them for follow-up actions',
  click: 'page.click takes {selector} or a snapshot ref',
  type: 'page.type takes {selector, text, clearFirst?}',
};

function pageActionHint(action: string): string | null {
  const bare = action.startsWith('page.') ? action.slice('page.'.length) : action;
  if (!(bare in PAGE_ACTION_HINTS) && !/^[a-zA-Z][a-zA-Z.]*$/.test(bare)) return null;
  const example = PAGE_ACTION_HINTS[bare] ? ` (${PAGE_ACTION_HINTS[bare]})` : '';
  return [
    `"${action}" is a page action; page actions never run top-level${example}.`,
    `One-shot form: ev browser oneShot --payload '{"url":"<url>","command":{"action":"page.${bare}", ...}}'.`,
    `Session form: ev browser session.command --payload '{"sessionId":"<id>","command":{"action":"page.${bare}", ...}}'.`,
    `Discover elements first with {"action":"page.snapshot","mode":"interactive"}.`,
  ].join(' ');
}

async function validateLocalFiles(command: BrowserCommand): Promise<void> {
  const scopedCommand =
    command.action === 'browser.oneShot' || command.action === 'browser.session.command'
      ? command.command
      : command;
  if (scopedCommand.action !== 'page.upload') return;
  for (const filePath of scopedCommand.filePaths) {
    if (!path.isAbsolute(filePath))
      throw new UsageError(`upload paths must be absolute: ${filePath}`);
    const info = await stat(filePath).catch(() => null);
    if (!info?.isFile())
      throw new UsageError(`upload target is missing or not a file: ${filePath}`);
  }
}

function discoveryPath(profile: string = DEFAULT_BROWSER_PROFILE): string {
  return process.env.EV_BROWSER_CONTROL_FILE?.trim() || standaloneDiscoveryPath(profile);
}

async function readDiscovery(
  profile: string = DEFAULT_BROWSER_PROFILE
): Promise<DiscoveryFile & { token: string }> {
  const filePath = discoveryPath(profile);
  let decoded: unknown;
  try {
    decoded = JSON.parse(await readFile(filePath, 'utf8'));
  } catch {
    throw new Error('EV Desktop is not running or the Browser CLI service is unavailable');
  }
  if (!decoded || typeof decoded !== 'object')
    throw new Error('Browser CLI discovery file is invalid');
  const value = decoded as Record<string, unknown>;
  if (
    value.protocolVersion !== EV_PROTOCOL_VERSION ||
    typeof value.socketPath !== 'string' ||
    typeof value.tokenPath !== 'string'
  ) {
    throw new Error('Browser CLI discovery file version or fields are invalid');
  }
  const token = (await readFile(value.tokenPath, 'utf8')).trim();
  if (token.length < 32) throw new Error('Browser CLI token is invalid');
  return {
    protocolVersion: EV_PROTOCOL_VERSION,
    socketPath: value.socketPath,
    tokenPath: value.tokenPath,
    token,
  };
}

async function invoke(
  command: BrowserCommand | BrowserHostControlCommand,
  timeoutMs: number,
  profile: string = DEFAULT_BROWSER_PROFILE
): Promise<unknown> {
  const discovery = await readDiscovery(profile);
  const requestId = randomUUID();
  const request = {
    protocolVersion: EV_PROTOCOL_VERSION,
    requestId,
    token: discovery.token,
    command,
  };

  const response = await new Promise<unknown>((resolve, reject) => {
    const socket = net.createConnection(discovery.socketPath);
    let input = '';
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      callback();
    };
    socket.setEncoding('utf8');
    socket.setTimeout(timeoutMs);
    socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on('timeout', () => finish(() => reject(new Error('Browser command timed out'))));
    socket.on('error', error => finish(() => reject(error)));
    socket.on('data', chunk => {
      input += chunk;
      if (Buffer.byteLength(input, 'utf8') > MAX_RESPONSE_BYTES) {
        finish(() => reject(new Error('Browser response exceeds 16 MiB')));
        return;
      }
      const newline = input.indexOf('\n');
      if (newline < 0) return;
      try {
        const parsed = BrowserControlResponseSchema.parse(JSON.parse(input.slice(0, newline)));
        if (parsed.requestId !== requestId) throw new Error('Browser response ID does not match');
        finish(() => resolve(parsed));
      } catch (error) {
        finish(() => reject(error));
      }
    });
  });

  const parsed = BrowserControlResponseSchema.parse(response);
  if (!parsed.success) {
    const error = new Error(parsed.error.message);
    error.name = parsed.error.code;
    throw error;
  }
  return parsed.data;
}

// --- Pairing ---------------------------------------------------------------
// A standalone Host never trusts an extension id: an unpacked build gets a
// fresh id on every machine and directory, so the first connection from a
// browser lands as a pending request and needs one explicit approval. The
// approval issues a pairing token the extension stores, so reconnects are
// silent. Without surfacing pending requests, a rejected-but-invisible
// handshake looks identical to "the extension is broken".

interface PairingRequest {
  browserId: string;
  browserName: string;
  extensionVersion: string;
  origin: string;
}

interface PairedBrowser {
  browserId: string;
  browserName: string;
  origin: string;
  online: boolean;
}

interface PairingSnapshot {
  pendingPairings: PairingRequest[];
  pairedBrowsers: PairedBrowser[];
}

const PAIRING_HINT_TIMEOUT_MS = 3_000;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function asText(value: unknown, key: string): string {
  const field = asRecord(value)[key];
  return typeof field === 'string' ? field : '';
}

function pairingSnapshot(data: unknown): PairingSnapshot {
  const value = asRecord(data);
  const pending: unknown[] = Array.isArray(value.pendingPairings) ? value.pendingPairings : [];
  const paired: unknown[] = Array.isArray(value.pairedBrowsers) ? value.pairedBrowsers : [];
  return {
    pendingPairings: pending
      .map(entry => ({
        browserId: asText(entry, 'browserId'),
        browserName: asText(entry, 'browserName'),
        extensionVersion: asText(entry, 'extensionVersion'),
        origin: asText(entry, 'origin'),
      }))
      .filter(entry => entry.browserId !== ''),
    pairedBrowsers: paired
      .map(entry => ({
        browserId: asText(entry, 'browserId'),
        browserName: asText(entry, 'browserName'),
        origin: asText(entry, 'origin'),
        online: asRecord(entry).online === true,
      }))
      .filter(entry => entry.browserId !== ''),
  };
}

function approveCommand(profile: string, browserId: string): string {
  const suffix = profile === DEFAULT_BROWSER_PROFILE ? '' : ` --profile ${profile}`;
  return `ev browser pairing approve ${browserId}${suffix}`;
}

function formatPairingList(snapshot: PairingSnapshot, profile: string): string {
  const lines: string[] = [];
  if (snapshot.pendingPairings.length === 0) {
    lines.push('No EV Browser pairing request is waiting for approval.');
  } else {
    lines.push(`Waiting for approval (${snapshot.pendingPairings.length}):`);
    for (const pending of snapshot.pendingPairings) {
      lines.push(`  ${pending.browserName || 'EV Browser'} ${pending.extensionVersion}`);
      lines.push(`    origin:    ${pending.origin}`);
      lines.push(`    browserId: ${pending.browserId}`);
      lines.push(`    approve:   ${approveCommand(profile, pending.browserId)}`);
    }
  }
  if (snapshot.pairedBrowsers.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push(`Paired browsers (${snapshot.pairedBrowsers.length}):`);
    for (const browser of snapshot.pairedBrowsers) {
      const state = browser.online ? 'online ' : 'offline';
      lines.push(`  ${state}  ${browser.browserName || 'EV Browser'}  ${browser.origin}`);
      lines.push(`    browserId: ${browser.browserId}`);
    }
  }
  return lines.join('\n');
}

/**
 * Explain a "not connected" failure: the Host is usually fine and a browser is
 * simply waiting to be approved. Best effort — a Host that cannot answer
 * pairing.list yields no hint rather than a new error.
 */
async function pendingPairingHint(profile: string): Promise<string> {
  try {
    const snapshot = pairingSnapshot(
      await invoke({ action: 'pairing.list' }, PAIRING_HINT_TIMEOUT_MS, profile)
    );
    if (snapshot.pendingPairings.length === 0) return '';
    return [
      '',
      `${snapshot.pendingPairings.length} EV Browser pairing request(s) are waiting for approval:`,
      ...snapshot.pendingPairings.map(pending => `  ${approveCommand(profile, pending.browserId)}`),
      'Approve once per browser; the extension then reuses its pairing token on every reconnect.',
    ].join('\n');
  } catch {
    return '';
  }
}

function bookmarkBackup(data: unknown): { exportedAt?: string; tree: unknown[] } {
  if (!data || typeof data !== 'object' || !('tree' in data) || !Array.isArray(data.tree)) {
    throw new Error('Bookmark export response does not contain a tree');
  }
  const exportedAt =
    'exportedAt' in data && typeof data.exportedAt === 'string' ? data.exportedAt : undefined;
  return { exportedAt, tree: data.tree };
}

async function writeBookmarkBackup(data: unknown, outputPath: string): Promise<string> {
  const backup = bookmarkBackup(data);
  const resolved = path.resolve(outputPath);
  await mkdir(path.dirname(resolved), { recursive: true, mode: 0o700 });
  await writeFile(resolved, `${JSON.stringify(backup, null, 2)}\n`, { mode: 0o600 });
  await chmod(resolved, 0o600);
  return resolved;
}

async function createAutomaticBookmarkBackup(
  timeoutMs: number,
  profile: string = DEFAULT_BROWSER_PROFILE,
  browserId?: string
): Promise<string> {
  // Back up the same browser the mutation targets; with several browsers
  // online an untargeted export is ambiguous.
  const backup = await invoke(
    browserId ? { action: 'bookmarks.export', browserId } : { action: 'bookmarks.export' },
    timeoutMs,
    profile
  );
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `${timestamp}-${randomUUID()}.json`;
  return writeBookmarkBackup(
    backup,
    path.join(evHomeDirectory(), 'backups', 'bookmarks', filename)
  );
}

async function saveOutput(
  command: BrowserCommand,
  data: unknown,
  outputPath: string
): Promise<unknown> {
  if (command.action === 'bookmarks.export') {
    const backup = bookmarkBackup(data);
    return {
      exportedAt: backup.exportedAt,
      topLevels: backup.tree.length,
      outputPath: await writeBookmarkBackup(data, outputPath),
    };
  }
  const scopedCommand =
    command.action === 'browser.oneShot' || command.action === 'browser.session.command'
      ? command.command
      : command;
  if (scopedCommand.action !== 'page.screenshot') {
    throw new UsageError('--output supports scoped page.screenshot and bookmarks.export only');
  }
  let screenshot = data;
  if (command.action === 'browser.oneShot' || command.action === 'browser.session.command') {
    screenshot = data && typeof data === 'object' && 'result' in data ? data.result : undefined;
  }
  if (
    !screenshot ||
    typeof screenshot !== 'object' ||
    !('data' in screenshot) ||
    typeof screenshot.data !== 'string'
  ) {
    throw new Error('Screenshot response does not contain image data');
  }
  await mkdir(path.dirname(path.resolve(outputPath)), { recursive: true, mode: 0o700 });
  await writeFile(outputPath, Buffer.from(screenshot.data, 'base64'), { mode: 0o600 });
  const { data: _encoded, ...metadata } = screenshot;
  return { ...metadata, outputPath: path.resolve(outputPath) };
}

export async function run(argv: string[]): Promise<number> {
  try {
    if (argv.includes('--version') || argv.includes('-v')) {
      process.stdout.write(`${cliPackage.version}\n`);
      return 0;
    }
    if (argv.length === 0) throw new UsageError(usage());
    if (isServerCliCommand(argv)) return await runServerCli(argv);
    if (argv[0] === 'browser' && argv[1] === 'host') {
      const hostProfile = extractHostProfile(argv);
      if (argv[2] === 'stop') {
        const stopped = await stopStandaloneHost(hostProfile);
        const suffix = hostProfile === DEFAULT_BROWSER_PROFILE ? '' : ` (profile: ${hostProfile})`;
        process.stdout.write(
          `${stopped ? 'Standalone Browser Host stopped' : 'No standalone Browser Host is running'}${suffix}\n`
        );
        return 0;
      }
      if (argv[2] && argv[2] !== 'serve' && argv[2] !== '--background') {
        throw new UsageError('usage: ev browser host [serve|stop] [--profile <name>]');
      }
      await runStandaloneHost(hostProfile);
      return 0;
    }
    if (argv[0] === 'browser' && argv[1] === 'profile') {
      if (argv[2] !== 'list') throw new UsageError('usage: ev browser profile list');
      const infos = await listBrowserProfiles();
      process.stdout.write(`${JSON.stringify({ profiles: infos }, null, 2)}\n`);
      return 0;
    }
    if (argv[0] === 'browser' && argv[1] === 'pairing') {
      const operation = argv[2];
      if (!operation || !['list', 'approve', 'reject'].includes(operation)) {
        throw new UsageError(
          'usage: ev browser pairing list|approve <browser-id>|reject <browser-id> [--profile <name>]'
        );
      }
      const profile = extractHostProfile(argv);
      if (!process.env.EV_BROWSER_CONTROL_FILE?.trim()) await ensureStandaloneHost(profile);
      if (operation === 'list') {
        const snapshot = pairingSnapshot(
          await invoke({ action: 'pairing.list' }, DEFAULT_TIMEOUT_MS, profile)
        );
        process.stdout.write(`${formatPairingList(snapshot, profile)}\n`);
        return 0;
      }
      const browserId = argv.slice(3).find(value => !value.startsWith('--'));
      if (!browserId) {
        throw new UsageError(`usage: ev browser pairing ${operation} <browser-id>`);
      }
      const command: BrowserHostControlCommand =
        operation === 'approve'
          ? { action: 'pairing.approve', browserId }
          : { action: 'pairing.reject', browserId };
      await invoke(command, DEFAULT_TIMEOUT_MS, profile);
      process.stdout.write(
        `${operation === 'approve' ? 'Approved' : 'Rejected'} EV Browser ${browserId} (profile: ${profile})\n`
      );
      return 0;
    }
    const parsed = await parseArguments(argv);
    const commandResult = BrowserCommandSchema.safeParse({
      action: parsed.action,
      ...parsed.payload,
    });
    if (!commandResult.success) {
      const issues = commandResult.error.issues
        .slice(0, 4)
        .map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ');
      const hint = pageActionHint(parsed.action);
      throw new UsageError(
        `unsupported browser action or invalid parameters — ${issues}${hint ? ` | ${hint}` : ''}`
      );
    }
    if (requiresBrowserSession(commandResult.data.action)) {
      const hint = pageActionHint(commandResult.data.action);
      throw new UsageError(
        `browser workspace actions require session.command or oneShot; direct user tabs are never used${hint ? ` | ${hint}` : ''}`
      );
    }
    await validateLocalFiles(commandResult.data);
    if (!process.env.EV_BROWSER_CONTROL_FILE?.trim()) await ensureStandaloneHost(parsed.profile);
    const backupPath = MUTATING_BOOKMARK_ACTIONS.has(commandResult.data.action)
      ? await createAutomaticBookmarkBackup(
          parsed.timeoutMs,
          parsed.profile,
          'browserId' in commandResult.data ? commandResult.data.browserId : undefined
        )
      : undefined;
    let data: unknown;
    try {
      data = await invoke(commandResult.data, parsed.timeoutMs, parsed.profile);
    } catch (error) {
      if (error instanceof Error) {
        // A pending approval is the usual reason nothing is connected; name
        // the exact approval command instead of leaving the user guessing.
        const hint = error.message.includes('not connected')
          ? await pendingPairingHint(parsed.profile)
          : '';
        if (backupPath) error.message = `${error.message} (bookmark backup: ${backupPath})`;
        if (hint) error.message = `${error.message}${hint}`;
      }
      throw error;
    }
    if (backupPath) {
      data =
        data && typeof data === 'object' && !Array.isArray(data)
          ? { ...data, backupPath }
          : { data, backupPath };
    }
    if (parsed.outputPath) data = await saveOutput(commandResult.data, data, parsed.outputPath);
    process.stdout.write(
      `${parsed.compact ? JSON.stringify(data) : JSON.stringify(data, null, 2)}\n`
    );
    return 0;
  } catch (error) {
    if (error instanceof UsageError || error instanceof CliError) {
      process.stderr.write(`${error.message}\n`);
      return 2;
    }
    process.stderr.write(
      `${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}\n`
    );
    return 1;
  }
}

void run(process.argv.slice(2)).then(code => {
  process.exitCode = code;
});
