import { Context } from 'cordis';
import { builtinRuntimePlugins } from '../runtime/runtime-plugins';
import { RuntimeRegistry } from '../runtime/runtime-registry';

export interface EvKernel {
  readonly context: Context;
  readonly runtimes: RuntimeRegistry;
  dispose(): Promise<void>;
}

export async function createEvKernel(): Promise<EvKernel> {
  const context = new Context();
  try {
    await context.plugin(RuntimeRegistry);
    for (const plugin of builtinRuntimePlugins) await context.plugin(plugin);
    context.runtimes.assertRequired('pi');
  } catch (error) {
    try {
      await context.fiber.dispose();
    } catch (disposeError) {
      throw new AggregateError([error, disposeError], 'EV Kernel startup and cleanup failed');
    }
    throw error;
  }

  let disposeTask: Promise<void> | undefined;
  return {
    context,
    runtimes: context.runtimes,
    dispose() {
      disposeTask ??= disposeKernel(context);
      return disposeTask;
    },
  };
}

async function disposeKernel(context: Context): Promise<void> {
  const failures: unknown[] = [];
  try {
    await context.runtimes.dispose();
  } catch (error) {
    failures.push(error);
  }
  try {
    await context.fiber.dispose();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, 'EV Kernel cleanup failed');
  }
}
