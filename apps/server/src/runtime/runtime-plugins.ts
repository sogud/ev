import type { Context, Plugin } from 'cordis';
import { ClaudeFamilyAdapter, CLAUDE_CODE_FLAVOR, QODER_FLAVOR } from './claude-family';
import { CodexAppServerAdapter } from './codex-app-server-adapter';
import { DshRuntimeAdapter } from './dsh-runtime-adapter';
import { PiRpcAdapter } from './pi-rpc-adapter';
import type { AgentRuntimeAdapter } from './runtime-adapter';

function defineRuntimePlugin(
  name: string,
  createAdapter: () => AgentRuntimeAdapter
): Plugin.Object<void> {
  return {
    name,
    inject: ['runtimes'],
    async apply(ctx: Context) {
      const adapter = createAdapter();
      try {
        ctx.runtimes.register(adapter);
      } catch (error) {
        try {
          await adapter.dispose?.();
        } catch (disposeError) {
          throw new AggregateError(
            [error, disposeError],
            `Runtime plugin ${name} failed to register and dispose its adapter`
          );
        }
        throw error;
      }
    },
  };
}

export const piRuntimePlugin = defineRuntimePlugin('runtime-pi', () => new PiRpcAdapter());
export const codexRuntimePlugin = defineRuntimePlugin(
  'runtime-codex',
  () => new CodexAppServerAdapter()
);
export const claudeRuntimePlugin = defineRuntimePlugin(
  'runtime-claude-code',
  () => new ClaudeFamilyAdapter(CLAUDE_CODE_FLAVOR)
);
export const qoderRuntimePlugin = defineRuntimePlugin(
  'runtime-qoder',
  () => new ClaudeFamilyAdapter(QODER_FLAVOR)
);
export const dshRuntimePlugin = defineRuntimePlugin('runtime-dsh', () => new DshRuntimeAdapter());

export const builtinRuntimePlugins = [
  piRuntimePlugin,
  codexRuntimePlugin,
  claudeRuntimePlugin,
  qoderRuntimePlugin,
  dshRuntimePlugin,
] as const;
