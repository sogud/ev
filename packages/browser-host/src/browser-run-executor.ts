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
        const item = step.items[itemIndex];
        if (item === undefined) throw new Error(`BrowserRun item ${itemIndex} is unavailable`);
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
        return {
          action: 'page.navigate',
          ...withTabId,
          frameId: command.frameId,
          url: command.url,
        };
      case 'page.history':
        return { action: 'page.history', ...withTabId, operation: command.operation };
      case 'page.press':
        return {
          action: 'page.press',
          ...withTabId,
          key: command.key,
          modifiers: command.modifiers,
        };
      case 'page.pointer':
        return {
          action: 'page.pointer',
          ...withTabId,
          type: command.type,
          x: command.x,
          y: command.y,
          button: command.button,
          clickCount: command.clickCount,
        };
      case 'page.dialog.respond':
        return {
          action: 'page.dialog.respond',
          ...withTabId,
          accept: command.accept,
          promptText: command.promptText,
        };
      case 'page.click':
        return {
          action: 'page.click',
          ...withTabId,
          frameId: command.frameId,
          selector: await this.resolveTarget(command.target, tabId, command.frameId),
          button: command.button,
          clickCount: command.clickCount,
          waitFor: command.waitFor,
          timeoutMs: command.timeoutMs,
        };
      case 'page.type': {
        const text = typeof command.text === 'string' ? command.text : item;
        if (text === undefined) throw new Error('BrowserRun item is unavailable');
        return {
          action: 'page.type',
          ...withTabId,
          frameId: command.frameId,
          selector: await this.resolveTarget(command.target, tabId, command.frameId),
          text,
          clearFirst: command.clearFirst,
        };
      }
      case 'page.setChecked':
        return {
          action: 'page.setChecked',
          ...withTabId,
          frameId: command.frameId,
          selector: await this.resolveTarget(command.target, tabId, command.frameId),
          checked: command.checked,
        };
      case 'page.select':
        return {
          action: 'page.select',
          ...withTabId,
          frameId: command.frameId,
          selector: await this.resolveTarget(command.target, tabId, command.frameId),
          values: command.values,
        };
      case 'page.drag': {
        const [sourceSelector, targetSelector] = await this.resolveTargets(
          [command.source, command.target],
          tabId,
          command.frameId
        );
        if (sourceSelector === undefined || targetSelector === undefined) {
          throw new Error('BrowserRun drag target resolution returned no result');
        }
        return {
          action: 'page.drag',
          ...withTabId,
          frameId: command.frameId,
          sourceSelector,
          targetSelector,
        };
      }
      case 'page.focus':
        return {
          action: 'page.focus',
          ...withTabId,
          frameId: command.frameId,
          selector: await this.resolveTarget(command.target, tabId, command.frameId),
        };
      case 'page.inspect':
        return {
          action: 'page.inspect',
          ...withTabId,
          frameId: command.frameId,
          selector: await this.resolveTarget(command.target, tabId, command.frameId),
          maxChars: command.maxChars,
        };
      case 'page.hover':
        return {
          action: 'page.hover',
          ...withTabId,
          frameId: command.frameId,
          selector: await this.resolveTarget(command.target, tabId, command.frameId),
        };
      case 'page.scroll':
        return {
          action: 'page.scroll',
          ...withTabId,
          frameId: command.frameId,
          selector: command.target
            ? await this.resolveTarget(command.target, tabId, command.frameId)
            : undefined,
          direction: command.direction,
          distance: command.distance,
          deltaX: command.deltaX,
          deltaY: command.deltaY,
        };
      case 'page.wait':
        return {
          action: 'page.wait',
          ...withTabId,
          frameId: command.frameId,
          condition: command.condition,
          selector: command.target
            ? await this.resolveTarget(command.target, tabId, command.frameId)
            : undefined,
          timeMs: command.timeMs,
          timeoutMs: command.timeoutMs,
          idleMs: command.idleMs,
        };
      default:
        throw new Error(`Unsupported BrowserRun action: ${(command as { action: string }).action}`);
    }
  }

  private async resolveTarget(
    target: BrowserRunTarget,
    tabId?: number,
    frameId?: string
  ): Promise<string> {
    const [resolved] = await this.resolveTargets([target], tabId, frameId);
    if (resolved === undefined) throw new Error('BrowserRun target resolution returned no result');
    return resolved;
  }

  private async resolveTargets(
    targets: BrowserRunTarget[],
    tabId?: number,
    frameId?: string
  ): Promise<string[]> {
    if (targets.every(target => 'selector' in target)) {
      return targets.map(target => ('selector' in target ? target.selector : ''));
    }
    const result = await this.sendAtomicCommand({
      action: 'page.snapshot',
      ...(tabId === undefined ? {} : { tabId }),
      ...(frameId === undefined ? {} : { frameId }),
      mode: 'interactive',
      maxNodes: 1_000,
    });
    const nodes = snapshotNodes(result);
    return targets.map(target => {
      if ('selector' in target) return target.selector;
      const exact = target.exact ?? true;
      const matches = nodes.filter(
        node =>
          node.role === target.role &&
          (exact ? node.name === target.name : node.name.includes(target.name))
      );
      const match = matches[target.index ?? 0];
      if (!match) throw new Error(`Semantic target not found: ${target.role} ${target.name}`);
      return match.ref;
    });
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
