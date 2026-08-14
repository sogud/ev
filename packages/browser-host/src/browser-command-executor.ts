import {
  BrowserDownloadDispatchSchema,
  BrowserDownloadStatusSchema,
  type BrowserAtomicCommand,
  type BrowserCommand,
  type BrowserRecipeCommand,
  type BrowserSessionCommand,
} from '@ev/contracts';
import type { BrowserBridgeService } from './browser-bridge-service';
import { BrowserRunExecutor } from './browser-run-executor';
import { BrowserSessionManager } from './browser-session-manager';
import type { MediaDownloadService } from './media-download-service';
import { defaultSiteRecipeFilePath, SiteRecipeRegistry } from './site-recipe-registry';

const SESSION_ACTIONS = [
  'browser.session.create',
  'browser.session.list',
  'browser.session.get',
  'browser.session.open',
  'browser.session.adoptTab',
  'browser.session.command',
  'browser.session.release',
] as const;

const RECIPE_ACTIONS = [
  'browser.recipe.list',
  'browser.recipe.get',
  'browser.recipe.draft.save',
  'browser.recipe.approve',
  'browser.recipe.run',
] as const;

function isRecipeCommand(command: BrowserCommand): command is BrowserRecipeCommand {
  return command.action.startsWith('browser.recipe.');
}

function isSessionCommand(command: BrowserCommand): command is BrowserSessionCommand {
  return command.action.startsWith('browser.session.');
}

function isAtomicCommand(command: BrowserCommand): command is BrowserAtomicCommand {
  return (
    command.action !== 'browser.run' && !isSessionCommand(command) && !isRecipeCommand(command)
  );
}

export class BrowserCommandExecutor {
  private readonly sessions: BrowserSessionManager;
  private readonly recipes: SiteRecipeRegistry;

  constructor(
    private readonly bridge: BrowserBridgeService,
    private readonly downloads: MediaDownloadService,
    recipeFilePath = defaultSiteRecipeFilePath()
  ) {
    this.sessions = new BrowserSessionManager(command => this.executeAtomic(command));
    this.recipes = new SiteRecipeRegistry(recipeFilePath, (sessionId, operation) =>
      this.sessions.runExclusive(sessionId, operation)
    );
  }

  async sendCommand(command: BrowserCommand): Promise<unknown> {
    if (isRecipeCommand(command)) return this.recipes.execute(command);
    if (isSessionCommand(command)) return this.sessions.execute(command);
    if (command.action === 'browser.run') {
      return new BrowserRunExecutor(atomic => this.executeAtomic(atomic)).execute(command);
    }
    if (!isAtomicCommand(command)) throw new Error('Unsupported Browser Host command');
    return this.executeAtomic(command);
  }

  private async executeAtomic(command: BrowserAtomicCommand): Promise<unknown> {
    if (command.action === 'downloads.status' && command.downloadId.startsWith('local:')) {
      return this.downloads.status(command.downloadId);
    }

    const result = await this.bridge.sendCommand(command);
    if (
      command.action === 'browser.capabilities' &&
      result &&
      typeof result === 'object' &&
      'actions' in result &&
      Array.isArray(result.actions)
    ) {
      const extensionActions = result.actions.filter(
        (action): action is string => typeof action === 'string'
      );
      const supportsPageControl = extensionActions.includes('page.navigate');
      const supportsSessions = supportsPageControl && extensionActions.includes('windows.open');
      return {
        ...result,
        actions: [
          ...new Set([
            ...extensionActions,
            ...(supportsPageControl ? ['browser.run'] : []),
            ...(supportsSessions ? [...SESSION_ACTIONS, ...RECIPE_ACTIONS] : []),
          ]),
        ],
      };
    }
    if (command.action !== 'page.download') return result;

    const dispatch = BrowserDownloadDispatchSchema.parse(result);
    if (dispatch.backend === 'external') return this.downloads.start(dispatch);
    return BrowserDownloadStatusSchema.parse({
      downloadId: `chrome:${dispatch.downloadId}`,
      backend: 'chrome',
      state: 'in_progress',
    });
  }
}
