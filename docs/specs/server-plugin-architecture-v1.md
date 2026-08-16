# Server Plugin Architecture v1

Status: active — Runtime tracer complete

## Goal

Turn `apps/server` into a statically composed Cordis application while preserving every existing client contract and product behavior. The first tracer bullet covers Runtime registration and lifecycle only.

## Product shape

```text
Desktop / Mobile / CLI
          │ HTTP + WebSocket contracts
          ▼
EV Server
  ├─ EV Kernel: root Context, built-in composition, startup, shutdown
  └─ built-in Server plugins
       ├─ persistence
       ├─ runtimes
       ├─ tasks
       ├─ management
       ├─ browser
       └─ HTTP / WebSocket

Browser Host / Extension remain separate execution hosts.
```

## Terms

- **EV Kernel** is the minimal non-plugin bootstrap that owns the root Cordis `Context`, mounts built-ins, reports startup failure, and disposes the root Fiber during shutdown.
- **Server Plugin** is trusted statically imported code mounted in the Server process. It contributes or consumes a deep Service and owns every resource it creates.
- **Service** is a stable capability available through the Context. Callers depend on its interface, not a concrete implementation.
- **Effect** is a reversible plugin-owned registration or resource. Unloading its Fiber removes the registration and waits for cleanup.

## Invariants

1. Client HTTP, WebSocket, and `@ev/contracts` behavior does not change during the migration.
2. Plugin dependency order is expressed with `inject`, not array position.
3. Direct capability calls use Service methods. Events are reserved for observation, interception, and lifecycle coordination.
4. A plugin unload removes all registrations and stops all child processes, sockets, timers, listeners, and watchers it owns.
5. Renderer input cannot select an executable, module path, package, argv, or Cordis config row.
6. Only explicit built-in imports are mounted. Cordis Loader, Include, HMR, and dynamic package loading are absent from v1.
7. Server tests mount plugins in an isolated Context. Existing runtime protocol tests remain adapter-level tests.
8. Runtime credentials, sessions, and native configuration remain owned by each Runtime.

## Runtime tracer bullet

### Kernel

- Pin upstream `cordis` to one exact version in `@ev/server`.
- Add `createEvKernel()` under `apps/server`; it returns the Context, Runtime registry Service, and one idempotent `dispose()` operation.
- Keep Cordis implementation details inside Server. No Cordis types enter `@ev/contracts`.

### Runtime Service

- Preserve the current `RuntimeRegistry` caller interface: `require`, `describeAll`, and `dispose`.
- Add reversible `register(adapter)` support. Duplicate Runtime IDs fail immediately.
- Require Pi when built-in Runtime composition finishes, not while an empty registry Service is being constructed.

### Built-in Runtime plugins

- Mount Pi, Codex, Claude Code, Qoder, and Experimental DSH as separate plugins.
- Each plugin injects the Runtime registry Service and registers exactly one adapter through a Cordis Effect.
- Fiber unload removes and disposes only that adapter. Root disposal releases every adapter once.
- Adapter descriptors, process isolation, native session ownership, and UI behavior remain unchanged.

### Composition root

- Replace the Runtime adapter array in `server.ts` with `createEvKernel()`.
- Continue passing the Runtime registry interface to `AgentService` until the Task plugin migration.
- Server shutdown disposes `AgentService` before the Kernel so Task-owned sessions close before adapter-owned resources.

## Acceptance

- All five Runtime descriptors remain present and ordered deterministically.
- Duplicate registration fails without replacing the first adapter.
- Unloading one Runtime plugin removes that descriptor, disposes its adapter once, and leaves other Runtime plugins active.
- Missing Pi fails built-in composition before Server starts accepting requests.
- Root disposal is idempotent and reports aggregated cleanup failures.
- Existing DSH official source smoke, runtime tests, full typecheck, tests, lint, quality, and build pass.

## Runtime tracer result

- `@ev/server` pins upstream `cordis@4.0.0-rc.8` exactly.
- `createEvKernel()` mounts `RuntimeRegistry` as a Service, then mounts the five built-in Runtime plugins sequentially.
- Runtime registration is a Fiber-owned Effect. Plugin unload removes and disposes only its own adapter; descriptor order comes from `RuntimeIdSchema`.
- `server.ts` no longer imports or constructs Runtime adapters. Shutdown releases TaskSession instances before Kernel plugins.
- Packaged Server smoke created a DSH Task through HTTP, projected its assistant message, sent DSH shutdown on SIGTERM, and exited code 0 without leaving the child process.

## Later migrations

Migrate Store, Task/AgentService, Management, Browser Bridge/Control, and finally HTTP/WebSocket. Each step replaces its old composition code; EV will not retain parallel manual and Cordis lifecycle systems.
