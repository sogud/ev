#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import cliPackage from '../package.json' with { type: 'json' };
import {
  ensureStandaloneHost,
  runStandaloneHost,
  standaloneDiscoveryPath,
  stopStandaloneHost,
} from './standalone-host';
import {
  BrowserCommandSchema,
  BrowserControlResponseSchema,
  EV_PROTOCOL_VERSION,
  type BrowserCommand,
} from '@ev/contracts';
import { CliError, isServerCliCommand, runServerCli } from './server-cli';

const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;

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
}

class UsageError extends Error {}

function usage(): string {
  return [
    '用法：',
    '  ev browser <action> [--payload <json> | --payload-file <path>]',
    '                    [--timeout <seconds>] [--output <path>] [--compact]',
    '  ev browser check',
    '  ev status                     同网直连/Tailscale 双 URL + token 打码提示',
    '  ev remote on|off|status',
    '  ev token create --tier observer|operator | list | revoke <id>',
    '  ev server start|stop|status / ev task … / ev runtime …',
    '',
    '示例：',
    '  ev browser tabs.list',
    '  ev browser page.snapshot --payload \'{"mode":"interactive"}\'',
    '  ev browser page.click --payload \'{"selector":"@e1"}\'',
    '  ev browser page.media --payload \'{"tabId":123}\'',
    '  ev browser page.download --payload \'{"tabId":123,"ref":"@m1"}\'',
    '  ev browser downloads.status --payload \'{"downloadId":"chrome:42"}\'',
    '  ev browser page.screenshot --output ./page.png',
  ].join('\n');
}

async function parseArguments(argv: string[]): Promise<ParsedArguments> {
  if (argv[0] !== 'browser') throw new UsageError('当前仅支持 ev browser 命令');
  const action = argv[1];
  if (!action || action === '--help' || action === '-h') throw new UsageError(usage());

  let payload: Record<string, unknown> = {};
  let payloadFile: string | undefined;
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  let compact = false;
  let outputPath: string | undefined;

  for (let index = 2; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--payload') {
      const value = argv[++index];
      if (!value) throw new UsageError('--payload 缺少 JSON 参数');
      try {
        const decoded = JSON.parse(value);
        if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
          throw new Error('payload must be an object');
        }
        payload = decoded as Record<string, unknown>;
      } catch {
        throw new UsageError('--payload 必须是 JSON object');
      }
      continue;
    }
    if (argument === '--payload-file') {
      payloadFile = argv[++index];
      if (!payloadFile) throw new UsageError('--payload-file 缺少文件路径');
      continue;
    }
    if (argument === '--timeout') {
      const value = Number(argv[++index]);
      if (!Number.isFinite(value) || value <= 0 || value > 300) {
        throw new UsageError('--timeout 必须是 0–300 秒之间的数字');
      }
      timeoutMs = value * 1000;
      continue;
    }
    if (argument === '--output') {
      outputPath = argv[++index];
      if (!outputPath) throw new UsageError('--output 缺少文件路径');
      continue;
    }
    if (argument === '--compact') {
      compact = true;
      continue;
    }
    throw new UsageError(`未知参数：${argument}`);
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
        `无法读取 payload 文件：${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  return {
    action: action === 'check' ? 'browser.capabilities' : action,
    payload,
    timeoutMs,
    compact,
    outputPath,
  };
}

async function validateLocalFiles(command: BrowserCommand): Promise<void> {
  if (command.action !== 'page.upload') return;
  for (const filePath of command.filePaths) {
    if (!path.isAbsolute(filePath)) throw new UsageError(`上传文件必须使用绝对路径：${filePath}`);
    const info = await stat(filePath).catch(() => null);
    if (!info?.isFile()) throw new UsageError(`上传文件不存在或不是文件：${filePath}`);
  }
}

function discoveryPath(): string {
  return process.env.EV_BROWSER_CONTROL_FILE?.trim() || standaloneDiscoveryPath();
}

async function readDiscovery(): Promise<DiscoveryFile & { token: string }> {
  const filePath = discoveryPath();
  let decoded: unknown;
  try {
    decoded = JSON.parse(await readFile(filePath, 'utf8'));
  } catch {
    throw new Error('EV Desktop 未运行或 Browser CLI 服务不可用');
  }
  if (!decoded || typeof decoded !== 'object') throw new Error('Browser CLI discovery 文件无效');
  const value = decoded as Record<string, unknown>;
  if (
    value.protocolVersion !== EV_PROTOCOL_VERSION ||
    typeof value.socketPath !== 'string' ||
    typeof value.tokenPath !== 'string'
  ) {
    throw new Error('Browser CLI discovery 文件版本或字段无效');
  }
  const token = (await readFile(value.tokenPath, 'utf8')).trim();
  if (token.length < 32) throw new Error('Browser CLI token 无效');
  return {
    protocolVersion: EV_PROTOCOL_VERSION,
    socketPath: value.socketPath,
    tokenPath: value.tokenPath,
    token,
  };
}

async function invoke(command: BrowserCommand, timeoutMs: number): Promise<unknown> {
  const discovery = await readDiscovery();
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

async function saveOutput(
  command: BrowserCommand,
  data: unknown,
  outputPath: string
): Promise<unknown> {
  if (command.action !== 'page.screenshot') {
    throw new UsageError('--output 当前仅支持 page.screenshot');
  }
  if (!data || typeof data !== 'object' || !('data' in data) || typeof data.data !== 'string') {
    throw new Error('Screenshot response does not contain image data');
  }
  await writeFile(outputPath, Buffer.from(data.data, 'base64'));
  const { data: _encoded, ...metadata } = data;
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
      if (argv[2] === 'stop') {
        const stopped = await stopStandaloneHost();
        process.stdout.write(
          `${stopped ? 'Standalone Browser Host stopped' : 'No standalone Browser Host is running'}\n`
        );
        return 0;
      }
      if (argv[2] && argv[2] !== 'serve' && argv[2] !== '--background') {
        throw new UsageError('用法：ev browser host [serve|stop]');
      }
      await runStandaloneHost();
      return 0;
    }
    const parsed = await parseArguments(argv);
    const commandResult = BrowserCommandSchema.safeParse({
      action: parsed.action,
      ...parsed.payload,
    });
    if (!commandResult.success) {
      throw new UsageError('不支持或参数无效的浏览器 action');
    }
    await validateLocalFiles(commandResult.data);
    if (!process.env.EV_BROWSER_CONTROL_FILE?.trim()) await ensureStandaloneHost();
    let data = await invoke(commandResult.data, parsed.timeoutMs);
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
