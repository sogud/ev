import type { RuntimeDescriptor, RuntimeId } from '@ev/contracts';
import type { AgentRuntimeAdapter } from './runtime-adapter';

export class RuntimeRegistry {
  private readonly adapters: ReadonlyMap<RuntimeId, AgentRuntimeAdapter>;

  constructor(adapters: AgentRuntimeAdapter[]) {
    const indexed = new Map<RuntimeId, AgentRuntimeAdapter>();
    for (const adapter of adapters) {
      if (indexed.has(adapter.id)) throw new Error(`Duplicate runtime adapter: ${adapter.id}`);
      indexed.set(adapter.id, adapter);
    }
    if (!indexed.has('pi')) throw new Error('Pi runtime adapter is required');
    this.adapters = indexed;
  }

  require(id: RuntimeId): AgentRuntimeAdapter {
    const adapter = this.adapters.get(id);
    if (!adapter) throw new Error(`Runtime is not registered: ${id}`);
    return adapter;
  }

  async describeAll(): Promise<RuntimeDescriptor[]> {
    return Promise.all([...this.adapters.values()].map(adapter => adapter.describe()));
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.adapters.values()].map(adapter => adapter.dispose?.()));
  }
}
