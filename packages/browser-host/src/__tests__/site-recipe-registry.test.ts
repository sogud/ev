import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { BrowserSessionCommand, BrowserSessionScopedCommand } from '@ev/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SiteRecipeRegistry } from '../site-recipe-registry';

const SESSION_ID = '3f88e635-1ba1-4e8c-91fd-83d682959f8a';
const RUN_ID = '88b4763f-120d-4769-91bc-3802469c7775';
const capturedAt = '2026-08-11T00:00:00.000Z';
const directories: string[] = [];

async function recipeFile(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ev-site-recipes-'));
  directories.push(directory);
  return path.join(directory, 'browser-host', 'site-recipes.json');
}

function sessionResult(result: unknown): unknown {
  return { sessionId: SESSION_ID, tabId: 11, result };
}

function sessionRunner(executeSession: (command: BrowserSessionCommand) => Promise<unknown>) {
  return async function run<T>(
    sessionId: string,
    operation: (execute: (command: BrowserSessionScopedCommand) => Promise<unknown>) => Promise<T>
  ): Promise<T> {
    return operation(async command => {
      const response = await executeSession({
        action: 'browser.session.command',
        sessionId,
        command,
      });
      if (!response || typeof response !== 'object' || !('result' in response)) {
        throw new Error('Expected a BrowserSession command result');
      }
      return response.result;
    });
  };
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))
  );
});

describe('SiteRecipeRegistry', () => {
  it('lists immutable approved built-ins', async () => {
    const executeSession = vi.fn(async () => undefined);
    const registry = new SiteRecipeRegistry(await recipeFile(), sessionRunner(executeSession));

    await expect(registry.execute({ action: 'browser.recipe.list' })).resolves.toMatchObject({
      recipes: [
        {
          id: 'x.mute-words',
          kind: 'x.mute-words',
          source: 'builtin',
          status: 'approved',
        },
        {
          id: 'x.read-grok-conversation',
          kind: 'x.read-grok-conversation',
          source: 'builtin',
          status: 'approved',
        },
      ],
    });
    const recipe = (await registry.execute({
      action: 'browser.recipe.get',
      recipeId: 'x.mute-words',
    })) as { reviewToken: string };
    expect(recipe.reviewToken).toMatch(/^[a-f0-9]{64}$/);
    expect(executeSession).not.toHaveBeenCalled();
  });

  it('stores drafts as mode 600 and approves only the exact reviewed definition', async () => {
    const filePath = await recipeFile();
    const executeSession = vi.fn(async () =>
      sessionResult({
        url: 'https://x.com/i/grok/share/abc',
        title: 'Grok',
        text: 'conversation',
        capturedAt,
      })
    );
    const registry = new SiteRecipeRegistry(filePath, sessionRunner(executeSession));
    const definition = {
      id: 'x.read-grok-main',
      version: 1,
      title: 'Read Grok main',
      description: 'Reviewed main text extraction.',
      kind: 'x.read-grok-conversation' as const,
      domains: ['x.com' as const],
      pathPrefixes: ['/i/grok/'],
      scope: 'main' as const,
      defaultMaxChars: 50_000,
    };

    const draft = (await registry.execute({
      action: 'browser.recipe.draft.save',
      recipe: definition,
    })) as { reviewToken: string; status: string };
    expect(draft.status).toBe('draft');
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
    await expect(
      registry.execute({
        action: 'browser.recipe.run',
        recipeId: definition.id,
        sessionId: SESSION_ID,
        input: { kind: 'x.read-grok-conversation' },
      })
    ).rejects.toThrow('is not approved');
    await expect(
      registry.execute({
        action: 'browser.recipe.approve',
        recipeId: definition.id,
        reviewToken: '0'.repeat(64),
        confirm: 'APPROVE_SITE_RECIPE',
      })
    ).rejects.toThrow('review token changed');

    await expect(
      registry.execute({
        action: 'browser.recipe.approve',
        recipeId: definition.id,
        reviewToken: draft.reviewToken,
        confirm: 'APPROVE_SITE_RECIPE',
      })
    ).resolves.toMatchObject({ status: 'approved' });

    const reloaded = new SiteRecipeRegistry(filePath, sessionRunner(executeSession));
    await expect(
      reloaded.execute({ action: 'browser.recipe.get', recipeId: definition.id })
    ).resolves.toMatchObject({ source: 'user', status: 'approved' });

    const revised = (await reloaded.execute({
      action: 'browser.recipe.draft.save',
      recipe: { ...definition, version: 2 },
    })) as { reviewToken: string; status: string };
    expect(revised).toMatchObject({ status: 'draft' });
    expect(revised.reviewToken).not.toBe(draft.reviewToken);
    await expect(
      reloaded.execute({
        action: 'browser.recipe.run',
        recipeId: definition.id,
        sessionId: SESSION_ID,
        input: { kind: 'x.read-grok-conversation' },
      })
    ).rejects.toThrow('is not approved');
  });

  it('fails explicitly when user recipe storage is corrupt', async () => {
    const filePath = await recipeFile();
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, '{not-json', { mode: 0o600 });
    const registry = new SiteRecipeRegistry(filePath, sessionRunner(vi.fn(async () => undefined)));

    await expect(registry.execute({ action: 'browser.recipe.list' })).rejects.toThrow(
      'SiteRecipe storage is not valid JSON'
    );
  });

  it('runs x.mute-words locally and returns only verified added, skipped, and failed items', async () => {
    const sent: BrowserSessionCommand[] = [];
    let snapshotCalls = 0;
    const executeSession = vi.fn(async (command: BrowserSessionCommand) => {
      sent.push(command);
      if (command.action !== 'browser.session.command') throw new Error('unexpected command');
      if (command.command.action === 'page.context') {
        return sessionResult({
          url: 'https://x.com/settings/muted_keywords',
          title: 'Muted words',
          text: '',
          capturedAt,
        });
      }
      if (command.command.action === 'page.snapshot') {
        snapshotCalls += 1;
        return sessionResult({
          nodes:
            snapshotCalls === 1
              ? [{ ref: '@e1', role: 'text', name: 'existing' }]
              : [
                  { ref: '@e1', role: 'text', name: 'existing' },
                  { ref: '@e2', role: 'text', name: 'new' },
                ],
        });
      }
      if (command.command.action === 'browser.run') {
        expect(command.command.steps[0]).toMatchObject({
          kind: 'forEach',
          items: ['new', 'bad', 'ghost'],
          onError: 'continue',
        });
        return sessionResult({
          runId: RUN_ID,
          status: 'partial',
          summary: { commands: 10, iterations: 3, retries: 1, durationMs: 900 },
          failures: [{ itemIndex: 1, item: 'bad', message: 'target not found' }],
        });
      }
      throw new Error(`unexpected action ${command.command.action}`);
    });
    const registry = new SiteRecipeRegistry(await recipeFile(), sessionRunner(executeSession));

    await expect(
      registry.execute({
        action: 'browser.recipe.run',
        recipeId: 'x.mute-words',
        sessionId: SESSION_ID,
        input: { kind: 'x.mute-words', words: ['existing', 'new', 'bad', 'ghost'] },
      })
    ).resolves.toMatchObject({
      recipeId: 'x.mute-words',
      kind: 'x.mute-words',
      status: 'partial',
      output: {
        added: ['new'],
        skipped: ['existing'],
        failed: [
          { item: 'bad', message: 'target not found' },
          { item: 'ghost', message: 'Word was not present after save' },
        ],
      },
      summary: { requested: 4, attempted: 3, retries: 1 },
    });
    expect(sent.every(command => command.action === 'browser.session.command')).toBe(true);
  });

  it('rejects unmatched domains before mutation and reads bounded Grok main text', async () => {
    const evilSession = vi.fn(async () =>
      sessionResult({
        url: 'https://evilx.com/settings/muted_keywords',
        title: 'Fake X',
        text: '',
        capturedAt,
      })
    );
    const registry = new SiteRecipeRegistry(await recipeFile(), sessionRunner(evilSession));
    await expect(
      registry.execute({
        action: 'browser.recipe.run',
        recipeId: 'x.mute-words',
        sessionId: SESSION_ID,
        input: { kind: 'x.mute-words', words: ['never-send'] },
      })
    ).rejects.toThrow('does not allow https://evilx.com/settings/muted_keywords');
    expect(evilSession).toHaveBeenCalledOnce();

    const grokSession = vi.fn(async (command: BrowserSessionCommand) => {
      if (command.action !== 'browser.session.command') throw new Error('unexpected command');
      return sessionResult({
        url: 'https://x.com/i/grok/share/abc',
        title: 'Grok conversation',
        text: 'final conversation text',
        capturedAt,
      });
    });
    const grokRegistry = new SiteRecipeRegistry(await recipeFile(), sessionRunner(grokSession));
    await expect(
      grokRegistry.execute({
        action: 'browser.recipe.run',
        recipeId: 'x.read-grok-conversation',
        sessionId: SESSION_ID,
        input: { kind: 'x.read-grok-conversation', maxChars: 50_000 },
      })
    ).resolves.toEqual({
      recipeId: 'x.read-grok-conversation',
      version: 1,
      kind: 'x.read-grok-conversation',
      status: 'completed',
      output: {
        url: 'https://x.com/i/grok/share/abc',
        title: 'Grok conversation',
        text: 'final conversation text',
        capturedAt,
        truncated: false,
      },
    });
    expect(grokSession).toHaveBeenLastCalledWith({
      action: 'browser.session.command',
      sessionId: SESSION_ID,
      command: { action: 'page.context', scope: 'main', maxChars: 50_000 },
    });
  });
});
