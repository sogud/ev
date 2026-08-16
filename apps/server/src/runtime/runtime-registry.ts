import { RuntimeIdSchema, type RuntimeDescriptor, type RuntimeId } from '@ev/contracts';
import { type Context, Service } from 'cordis';
import type { AgentRuntimeAdapter } from './runtime-adapter';

declare module 'cordis' {
  interface Context {
    runtimes: RuntimeRegistry;
  }
}

interface RuntimeRegistration {
  adapter: AgentRuntimeAdapter;
  dispose: () => Promise<void>;
}

export class RuntimeRegistry extends Service {
  static provide = 'runtimes';

  private readonly registrations = new Map<RuntimeId, RuntimeRegistration>();

  constructor(ctx: Context) {
    super(ctx, 'runtimes');
  }

  register(adapter: AgentRuntimeAdapter): () => Promise<void> {
    if (this.registrations.has(adapter.id)) {
      throw new Error(`Duplicate runtime adapter: ${adapter.id}`);
    }
    const registration = { adapter } as RuntimeRegistration;
    registration.dispose = this.ctx.effect(() => {
      if (this.registrations.has(adapter.id)) {
        throw new Error(`Duplicate runtime adapter: ${adapter.id}`);
      }
      this.registrations.set(adapter.id, registration);
      return async () => {
        if (this.registrations.get(adapter.id) !== registration) return;
        this.registrations.delete(adapter.id);
        await adapter.dispose?.();
      };
    }, `register runtime ${adapter.id}`);
    return registration.dispose;
  }

  assertRequired(...ids: RuntimeId[]): void {
    for (const id of ids) {
      if (!this.registrations.has(id)) throw new Error(`${id} runtime adapter is required`);
    }
  }

  require(id: RuntimeId): AgentRuntimeAdapter {
    const registration = this.registrations.get(id);
    if (!registration) throw new Error(`Runtime is not registered: ${id}`);
    return registration.adapter;
  }

  async describeAll(): Promise<RuntimeDescriptor[]> {
    return Promise.all(
      RuntimeIdSchema.options.flatMap(id => {
        const registration = this.registrations.get(id);
        return registration ? [registration.adapter.describe()] : [];
      })
    );
  }

  async dispose(): Promise<void> {
    const results = await Promise.allSettled(
      [...this.registrations.values()].map(registration => registration.dispose())
    );
    const failures = results.flatMap(result =>
      result.status === 'rejected' ? [result.reason] : []
    );
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Unable to dispose every Runtime adapter');
    }
  }
}
