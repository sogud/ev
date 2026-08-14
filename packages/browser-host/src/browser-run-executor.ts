import { randomUUID } from 'node:crypto';
import {
  BrowserRunResultSchema,
  type BrowserAtomicCommand,
  type BrowserRunCommand,
  type BrowserRunCommandStep,
  type BrowserRunResult,
  type BrowserRunTarget,
  type BrowserRunWaitStep,
} from '@ev/contracts';

const DEFAULT_RUN_TIMEOUT_MS = 30_000;
const MAX_COMMAND_ATTEMPTS = 2_000;

type SendAtomicCommand = (command: BrowserAtomicCommand) => Promise<unknown>;

interface RunSummary {
  commands: number;
  iterations: number;
  retries: number;
}

interface RunFailure {
  stepId?: string;
  itemIndex?: number;
  item?: string;
  message: string;
}

interface SnapshotNode {
  ref: string;
  role: string;
  name: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function snapshotNodes(value: unknown): SnapshotNode[] {
  if (!value || typeof value !== 'object' || !('nodes' in value) || !Array.isArray(value.nodes)) {
    throw new Error('Browser snapshot did not return nodes');
  }
  return value.nodes.filter(
    (node): node is SnapshotNode =>
      Boolean(node) &&
      typeof node === 'object' &&
      'ref' in node &&
      typeof node.ref === 'string' &&
      'role' in node &&
      typeof node.role === 'string' &&
      'name' in node &&
      typeof node.name === 'string'
  );
}

export class BrowserRunExecutor {
  constructor(private readonly sendAtomicCommand: SendAtomicCommand) {}

  async execute(run: BrowserRunCommand): Promise<BrowserRunResult> {
    const startedAt = Date.now();
    const deadline = startedAt + (run.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS);
    const summary: RunSummary = { commands: 0, iterations: 0, retries: 0 };
    const failures: RunFailure[] = [];

    for (const step of run.steps) {
      if (step.kind !== 'forEach') {
        try {
          await this.executeLeaf(step, run.tabId, undefined, summary, deadline);
        } catch (error) {
          failures.push({ stepId: step.id, message: errorMessage(error) });
          return this.result('failed', startedAt, summary, failures);
        }
        continue;
      }

      for (let itemIndex = 0; itemIndex < step.items.length; itemIndex += 1) {
        const item = step.items[itemIndex]!;
        summary.iterations += 1;
        let failedStepId = step.id;
        try {
          for (const child of step.steps) {
            failedStepId = child.id ?? step.id;
            await this.executeLeaf(child, run.tabId, item, summary, deadline);
          }
        } catch (error) {
          failures.push({
            stepId: failedStepId,
            itemIndex,
            item,
            message: errorMessage(error),
          });
          if ((step.onError ?? 'stop') === 'stop') {
            return this.result('failed', startedAt, summary, failures);
          }
        }
      }
    }

    return this.result(failures.length ? 'partial' : 'completed', startedAt, summary, failures);
  }

  private async executeLeaf(
    step: BrowserRunCommandStep | BrowserRunWaitStep,
    tabId: number | undefined,
    item: string | undefined,
    summary: RunSummary,
    deadline: number
  ): Promise<void> {
    this.assertWithinDeadline(deadline);
    if (step.kind === 'wait') {
      if (Date.now() + step.timeMs > deadline) throw new Error('BrowserRun timed out');
      await new Promise(resolve => setTimeout(resolve, step.timeMs));
      return;
    }

    const attempts = step.retry?.attempts ?? 1;
    const delayMs = step.retry?.delayMs ?? 0;
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      this.assertWithinDeadline(deadline);
      if (summary.commands >= MAX_COMMAND_ATTEMPTS) {
        throw new Error('BrowserRun exceeded 2,000 atomic command attempts');
      }
      summary.commands += 1;
      if (attempt > 0) summary.retries += 1;
      try {
        const command = await this.materializeCommand(step, tabId, item);
        await this.sendAtomicCommand(command);
        return;
      } catch (error) {
        lastError = error;
        if (attempt + 1 >= attempts) break;
        if (Date.now() + delayMs > deadline) throw new Error('BrowserRun timed out');
        if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
    throw lastError;
  }

  private async materializeCommand(
    step: BrowserRunCommandStep,
    tabId: number | undefined,
    item: string | undefined
  ): Promise<BrowserAtomicCommand> {
    const command = step.command;
    const withTabId = tabId === undefined ? {} : { tabId };
    switch (command.action) {
      case 'page.navigate':
        return { action: 'page.navigate', ...withTabId, url: command.url };
      case 'page.press':
        return {
          action: 'page.press',
          ...withTabId,
          key: command.key,
          modifiers: command.modifiers,
        };
      case 'page.click':
        return {
          action: 'page.click',
          ...withTabId,
          selector: await this.resolveTarget(command.target, tabId),
        };
      case 'page.type': {
        const text = typeof command.text === 'string' ? command.text : item;
        if (text === undefined) throw new Error('BrowserRun item is unavailable');
        return {
          action: 'page.type',
          ...withTabId,
          selector: await this.resolveTarget(command.target, tabId),
          text,
          clearFirst: command.clearFirst,
        };
      }
    }
  }

  private async resolveTarget(target: BrowserRunTarget, tabId?: number): Promise<string> {
    if ('selector' in target) return target.selector;
    const result = await this.sendAtomicCommand({
      action: 'page.snapshot',
      ...(tabId === undefined ? {} : { tabId }),
      mode: 'interactive',
      maxNodes: 1_000,
    });
    const exact = target.exact ?? true;
    const matches = snapshotNodes(result).filter(
      node =>
        node.role === target.role &&
        (exact ? node.name === target.name : node.name.includes(target.name))
    );
    const match = matches[target.index ?? 0];
    if (!match) throw new Error(`Semantic target not found: ${target.role} ${target.name}`);
    return match.ref;
  }

  private assertWithinDeadline(deadline: number): void {
    if (Date.now() > deadline) throw new Error('BrowserRun timed out');
  }

  private result(
    status: BrowserRunResult['status'],
    startedAt: number,
    summary: RunSummary,
    failures: RunFailure[]
  ): BrowserRunResult {
    return BrowserRunResultSchema.parse({
      runId: randomUUID(),
      status,
      summary: { ...summary, durationMs: Math.max(0, Date.now() - startedAt) },
      failures,
    });
  }
}
