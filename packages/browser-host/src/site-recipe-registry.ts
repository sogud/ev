import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  BrowserPageContextResultSchema,
  BrowserRecipeCommandSchema,
  BrowserRunCommandSchema,
  BrowserRunResultSchema,
  SiteRecipeDefinitionSchema,
  SiteRecipeListResultSchema,
  SiteRecipeRunResultSchema,
  SiteRecipeSchema,
  type BrowserRecipeCommand,
  type BrowserSessionScopedCommand,
  type SiteRecipe,
  type SiteRecipeDefinition,
  type SiteRecipeRunInput,
} from '@ev/contracts';

const STORAGE_VERSION = 1;
const MAX_USER_RECIPES = 100;
const MAX_RECIPE_BYTES = 64 * 1024;

type ScopedCommandExecutor = (command: BrowserSessionScopedCommand) => Promise<unknown>;
export type SiteRecipeSessionRunner = <T>(
  sessionId: string,
  operation: (execute: ScopedCommandExecutor) => Promise<T>
) => Promise<T>;

export function defaultSiteRecipeFilePath(): string {
  const evHome = process.env.EV_HOME?.trim() || path.join(os.homedir(), '.ev');
  return path.join(evHome, 'browser-host', 'site-recipes.json');
}

function reviewToken(definition: SiteRecipeDefinition): string {
  return createHash('sha256').update(JSON.stringify(definition)).digest('hex');
}

function approvedBuiltin(definition: SiteRecipeDefinition): SiteRecipe {
  return SiteRecipeSchema.parse({
    ...definition,
    source: 'builtin',
    status: 'approved',
    reviewToken: reviewToken(definition),
  });
}

const BUILTIN_RECIPES = [
  approvedBuiltin(
    SiteRecipeDefinitionSchema.parse({
      id: 'x.mute-words',
      version: 1,
      title: 'Mute words on X',
      description: 'Add muted words through the reviewed Chinese X settings UI.',
      kind: 'x.mute-words',
      domains: ['x.com', 'twitter.com'],
      pathPrefixes: ['/settings/muted_keywords'],
      targets: {
        add: { role: 'link', name: '添加隐藏的字词或短语' },
        input: { role: 'textbox', name: '输入字词或短语' },
        save: { role: 'button', name: '保存' },
      },
      retry: { attempts: 8, delayMs: 400 },
      waitAfterItemMs: 300,
    })
  ),
  approvedBuiltin(
    SiteRecipeDefinitionSchema.parse({
      id: 'x.read-grok-conversation',
      version: 1,
      title: 'Read an X Grok conversation',
      description: 'Return bounded text from the main region of an X Grok conversation.',
      kind: 'x.read-grok-conversation',
      domains: ['x.com', 'twitter.com'],
      pathPrefixes: ['/i/grok/', '/i/grok/share/'],
      scope: 'main',
      defaultMaxChars: 100_000,
    })
  ),
] as const;

const BUILTIN_IDS = new Set(BUILTIN_RECIPES.map(recipe => recipe.id));

export class SiteRecipeRegistry {
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly runInSession: SiteRecipeSessionRunner
  ) {}

  async execute(command: BrowserRecipeCommand): Promise<unknown> {
    const parsed = BrowserRecipeCommandSchema.parse(command);
    switch (parsed.action) {
      case 'browser.recipe.list':
        return this.afterMutations(() => this.list());
      case 'browser.recipe.get':
        return this.afterMutations(() => this.get(parsed.recipeId));
      case 'browser.recipe.draft.save':
        return this.withMutationLock(() => this.saveDraft(parsed.recipe));
      case 'browser.recipe.approve':
        return this.withMutationLock(() => this.approve(parsed.recipeId, parsed.reviewToken));
      case 'browser.recipe.run':
        return this.afterMutations(() => this.run(parsed.recipeId, parsed.sessionId, parsed.input));
    }
  }

  private async list(): Promise<{ recipes: SiteRecipe[] }> {
    const users = await this.loadUserRecipes();
    return SiteRecipeListResultSchema.parse({
      recipes: [
        ...BUILTIN_RECIPES,
        ...users.sort((left, right) => left.id.localeCompare(right.id)),
      ],
    });
  }

  private async get(recipeId: string): Promise<SiteRecipe> {
    const builtin = BUILTIN_RECIPES.find(recipe => recipe.id === recipeId);
    if (builtin) return builtin;
    const recipe = (await this.loadUserRecipes()).find(candidate => candidate.id === recipeId);
    if (!recipe) throw new Error(`SiteRecipe ${recipeId} not found`);
    return recipe;
  }

  private async saveDraft(input: SiteRecipeDefinition): Promise<SiteRecipe> {
    const definition = SiteRecipeDefinitionSchema.parse(input);
    if (BUILTIN_IDS.has(definition.id)) {
      throw new Error(`Built-in SiteRecipe ${definition.id} is immutable`);
    }
    if (Buffer.byteLength(JSON.stringify(definition), 'utf8') > MAX_RECIPE_BYTES) {
      throw new Error('SiteRecipe definition exceeds 64 KiB');
    }

    const recipes = await this.loadUserRecipes();
    const existingIndex = recipes.findIndex(recipe => recipe.id === definition.id);
    if (existingIndex < 0 && recipes.length >= MAX_USER_RECIPES) {
      throw new Error(`SiteRecipe storage cannot exceed ${MAX_USER_RECIPES} user recipes`);
    }
    const draft = SiteRecipeSchema.parse({
      ...definition,
      source: 'user',
      status: 'draft',
      reviewToken: reviewToken(definition),
    });
    if (existingIndex < 0) recipes.push(draft);
    else recipes[existingIndex] = draft;
    await this.writeUserRecipes(recipes);
    return draft;
  }

  private async approve(recipeId: string, token: string): Promise<SiteRecipe> {
    if (BUILTIN_IDS.has(recipeId)) throw new Error(`Built-in SiteRecipe ${recipeId} is immutable`);
    const recipes = await this.loadUserRecipes();
    const index = recipes.findIndex(recipe => recipe.id === recipeId);
    if (index < 0) throw new Error(`SiteRecipe ${recipeId} not found`);
    const recipe = recipes[index]!;
    if (recipe.reviewToken !== token) {
      throw new Error(`SiteRecipe ${recipeId} review token changed`);
    }
    if (recipe.status === 'approved') return recipe;

    const approved = SiteRecipeSchema.parse({ ...recipe, status: 'approved' });
    recipes[index] = approved;
    await this.writeUserRecipes(recipes);
    return approved;
  }

  private async run(
    recipeId: string,
    sessionId: string,
    input: SiteRecipeRunInput
  ): Promise<unknown> {
    const recipe = await this.get(recipeId);
    if (recipe.status !== 'approved') throw new Error(`SiteRecipe ${recipeId} is not approved`);
    if (recipe.kind !== input.kind) {
      throw new Error(`SiteRecipe ${recipeId} expects ${recipe.kind} input`);
    }

    return this.runInSession(sessionId, async execute => {
      const context = await this.pageContext(execute, 'body', 1);
      this.assertAllowedPage(recipe, context.url);
      if (recipe.kind === 'x.mute-words' && input.kind === 'x.mute-words') {
        return this.runMuteWords(recipe, execute, input.words);
      }
      if (recipe.kind === 'x.read-grok-conversation' && input.kind === 'x.read-grok-conversation') {
        return this.readGrokConversation(recipe, execute, input.maxChars);
      }
      throw new Error(`SiteRecipe ${recipeId} input does not match its adapter`);
    });
  }

  private async runMuteWords(
    recipe: Extract<SiteRecipe, { kind: 'x.mute-words' }>,
    execute: ScopedCommandExecutor,
    words: string[]
  ): Promise<unknown> {
    const startedAt = Date.now();
    const snapshot = await execute({
      action: 'page.snapshot',
      mode: 'full',
      maxNodes: 1_000,
      maxChars: 200_000,
    });
    const existingNames = new Set(
      snapshotNodes(snapshot)
        .map(node => node.name.trim())
        .filter(Boolean)
    );
    const skipped = words.filter(word => existingNames.has(word));
    const pending = words.filter(word => !existingNames.has(word));
    if (pending.length === 0) {
      return SiteRecipeRunResultSchema.parse({
        recipeId: recipe.id,
        version: recipe.version,
        kind: recipe.kind,
        status: 'completed',
        output: { added: [], skipped, failed: [] },
        summary: {
          requested: words.length,
          attempted: 0,
          retries: 0,
          durationMs: Math.max(0, Date.now() - startedAt),
        },
      });
    }

    const runCommand = BrowserRunCommandSchema.parse({
      action: 'browser.run',
      steps: [
        {
          kind: 'forEach',
          id: 'mute-words',
          items: pending,
          onError: 'continue',
          steps: [
            {
              kind: 'command',
              id: 'open-form',
              command: { action: 'page.click', target: recipe.targets.add },
              retry: recipe.retry,
            },
            {
              kind: 'command',
              id: 'type-word',
              command: {
                action: 'page.type',
                target: recipe.targets.input,
                text: { from: 'item' },
                clearFirst: true,
              },
              retry: recipe.retry,
            },
            {
              kind: 'command',
              id: 'save-word',
              command: { action: 'page.click', target: recipe.targets.save },
              retry: recipe.retry,
            },
            { kind: 'wait', id: 'settle', timeMs: recipe.waitAfterItemMs },
          ],
        },
      ],
    });
    const run = BrowserRunResultSchema.parse(await execute(runCommand));
    const verification = await execute({
      action: 'page.snapshot',
      mode: 'full',
      maxNodes: 1_000,
      maxChars: 200_000,
    });
    const finalNames = new Set(
      snapshotNodes(verification)
        .map(node => node.name.trim())
        .filter(Boolean)
    );
    const runFailures = new Map(
      run.failures.flatMap(failure => {
        const item =
          failure.item ??
          (failure.itemIndex === undefined ? undefined : pending[failure.itemIndex]);
        return item ? [[item, failure.message] as const] : [];
      })
    );
    const added = pending.filter(word => finalNames.has(word));
    const failed = pending.flatMap(word =>
      finalNames.has(word)
        ? []
        : [
            {
              item: word,
              message: runFailures.get(word) ?? 'Word was not present after save',
            },
          ]
    );
    let status: 'completed' | 'partial' | 'failed' = 'completed';
    if (failed.length > 0) status = added.length > 0 ? 'partial' : 'failed';
    return SiteRecipeRunResultSchema.parse({
      recipeId: recipe.id,
      version: recipe.version,
      kind: recipe.kind,
      status,
      output: {
        added,
        skipped,
        failed,
      },
      summary: {
        requested: words.length,
        attempted: pending.length,
        retries: run.summary.retries,
        durationMs: Math.max(0, Date.now() - startedAt),
      },
    });
  }

  private async readGrokConversation(
    recipe: Extract<SiteRecipe, { kind: 'x.read-grok-conversation' }>,
    execute: ScopedCommandExecutor,
    requestedMaxChars?: number
  ): Promise<unknown> {
    const maxChars = requestedMaxChars ?? recipe.defaultMaxChars;
    const context = await this.pageContext(execute, recipe.scope, maxChars);
    this.assertAllowedPage(recipe, context.url);
    return SiteRecipeRunResultSchema.parse({
      recipeId: recipe.id,
      version: recipe.version,
      kind: recipe.kind,
      status: 'completed',
      output: {
        ...context,
        truncated: context.text.length >= maxChars,
      },
    });
  }

  private async pageContext(
    execute: ScopedCommandExecutor,
    scope: 'body' | 'main',
    maxChars: number
  ) {
    return BrowserPageContextResultSchema.parse(
      await execute({ action: 'page.context', scope, maxChars })
    );
  }

  private assertAllowedPage(recipe: SiteRecipe, rawUrl: string): void {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch (error) {
      throw new Error(`SiteRecipe ${recipe.id} received an invalid page URL`, { cause: error });
    }
    const allowed =
      ['http:', 'https:'].includes(url.protocol) &&
      recipe.domains.includes(url.hostname as (typeof recipe.domains)[number]) &&
      recipe.pathPrefixes.some(prefix => url.pathname.startsWith(prefix));
    if (!allowed) throw new Error(`SiteRecipe ${recipe.id} does not allow ${rawUrl}`);
  }

  private async loadUserRecipes(): Promise<SiteRecipe[]> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }

    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch (error) {
      throw new Error('SiteRecipe storage is not valid JSON', { cause: error });
    }
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
      throw new Error('SiteRecipe storage must be an object');
    }
    const record = decoded as Record<string, unknown>;
    if (record.version !== STORAGE_VERSION || !Array.isArray(record.recipes)) {
      throw new Error('SiteRecipe storage has an unsupported schema');
    }
    if (record.recipes.length > MAX_USER_RECIPES) {
      throw new Error(`SiteRecipe storage cannot exceed ${MAX_USER_RECIPES} user recipes`);
    }
    const recipes = record.recipes.map(recipe => SiteRecipeSchema.parse(recipe));
    if (recipes.some(recipe => recipe.source !== 'user')) {
      throw new Error('SiteRecipe storage may contain only user recipes');
    }
    const ids = recipes.map(recipe => recipe.id);
    if (new Set(ids).size !== ids.length || ids.some(id => BUILTIN_IDS.has(id))) {
      throw new Error('SiteRecipe storage contains duplicate or built-in IDs');
    }
    return recipes;
  }

  private async writeUserRecipes(recipes: SiteRecipe[]): Promise<void> {
    const directory = path.dirname(this.filePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    await writeFile(
      this.filePath,
      `${JSON.stringify({ version: STORAGE_VERSION, recipes }, null, 2)}\n`,
      { mode: 0o600 }
    );
    await chmod(this.filePath, 0o600);
  }

  private afterMutations<T>(operation: () => Promise<T>): Promise<T> {
    return this.mutationTail.then(operation);
  }

  private withMutationLock<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.mutationTail.then(operation);
    this.mutationTail = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }
}

function snapshotNodes(value: unknown): Array<{ name: string }> {
  if (!value || typeof value !== 'object' || !('nodes' in value) || !Array.isArray(value.nodes)) {
    throw new Error('Browser snapshot response is invalid');
  }
  return value.nodes.flatMap(node => {
    if (!node || typeof node !== 'object' || !('name' in node) || typeof node.name !== 'string') {
      return [];
    }
    return [{ name: node.name }];
  });
}
