import type { FleetPaneRead, FleetSnapshot } from '@ev/contracts';
import { type Context, Service, type Plugin } from 'cordis';
import { HerdrClient } from './herdr-client';

/**
 * Fleet polling service (herdr-fleet-v1): probes the local Herdr, polls the
 * fleet tree on an interval, and pushes FleetSnapshots over client-sync.
 *
 * Degradation model:
 * - herdr missing/down → one `available:false` push (never repeated), then
 *   probe-only retries with exponential backoff (5s → 60s cap); EV startup is
 *   never blocked on Herdr.
 * - herdr recovers → back to the light poll loop (`workspace/tab/pane list`
 *   only); `pane read` is on-demand and never enters polling.
 * - a failed poll drops straight into the probe/backoff lane.
 */

declare module 'cordis' {
  interface Context {
    fleet: FleetService;
  }
}

/** client-sync channel carrying FleetSnapshot pushes. */
export const FLEET_UPDATE_CHANNEL = 'fleet:update';

export interface FleetServiceOptions {
  /** Push snapshots to all connected clients (server WS broadcast). */
  broadcast: (channel: string, payload: unknown) => void;
  /** Explicit herdr binary path (EV_HERDR_PATH / tests); default `herdr` on PATH. */
  herdrPath?: string;
  /** Poll interval while herdr is available. Default 5s, floor 50ms. */
  intervalMs?: number;
  /** Base delay for probe retries while herdr is unavailable. Default 5s. */
  probeBackoffMs?: number;
  probeTimeoutMs?: number;
  /** Test hook: substitute the CLI client. */
  client?: Pick<HerdrClient, 'probe' | 'listFleet' | 'readPane'>;
}

const DEFAULT_INTERVAL_MS = 5_000;
const MIN_INTERVAL_MS = 50;
const DEFAULT_PROBE_BACKOFF_MS = 5_000;
const MAX_PROBE_BACKOFF_MS = 60_000;
const UNAVAILABLE_SNAPSHOT_FETCHED_NEVER = 0;

export class FleetService extends Service {
  static provide = 'fleet';

  private readonly options: FleetServiceOptions;
  private readonly client: Pick<HerdrClient, 'probe' | 'listFleet' | 'readPane'>;
  private readonly intervalMs: number;
  private readonly probeBackoffBaseMs: number;

  private available = false;
  private stopped = true;
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private backoffMs: number;
  /** Guards the "push available:false only once" contract across retries. */
  private unavailablePushPending = true;
  private lastSnapshot: FleetSnapshot = {
    available: false,
    fetchedAt: UNAVAILABLE_SNAPSHOT_FETCHED_NEVER,
    workspaces: [],
  };

  constructor(ctx: Context, options: FleetServiceOptions) {
    super(ctx, 'fleet');
    this.options = options;
    this.client =
      options.client ??
      new HerdrClient({ herdrPath: options.herdrPath, probeTimeoutMs: options.probeTimeoutMs });
    this.intervalMs = Math.max(MIN_INTERVAL_MS, options.intervalMs ?? DEFAULT_INTERVAL_MS);
    this.probeBackoffBaseMs = options.probeBackoffMs ?? DEFAULT_PROBE_BACKOFF_MS;
    this.backoffMs = this.probeBackoffBaseMs;
  }

  /** Starts the probe/poll loop asynchronously; returns immediately. */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.runCycle();
  }

  /** Idempotent; safe to call twice (plugin cleanup + explicit shutdown). */
  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** Last known snapshot for on-demand fetches (`fleet:get`). */
  snapshot(): FleetSnapshot {
    return this.lastSnapshot;
  }

  /**
   * On-demand pane output pull (`fleet:readPane`). Delegates to
   * herdr-client.readPane (recent-unwrapped). This is the ONLY place terminal
   * text is fetched, and it is never called from the poll loop — readPane must
   * stay off the polling path. A null from the client (pane gone / herdr down /
   * timeout) maps to an explicit error result so the UI never renders a blank.
   */
  async readPane(paneId: string, lines?: number): Promise<FleetPaneRead> {
    const output = await this.client.readPane(paneId, lines);
    if (output === null) {
      return {
        ok: false,
        error: 'Unable to read pane output (pane closed or Herdr unreachable).',
      };
    }
    return { ok: true, output };
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runCycle();
    }, delayMs);
    this.timer.unref?.();
  }

  private async runCycle(): Promise<void> {
    if (this.stopped || this.running) return;
    this.running = true;
    try {
      if (!this.available) {
        this.available = await this.client.probe();
        if (!this.available) {
          this.publishUnavailable();
          this.schedule(this.backoffMs);
          this.backoffMs = Math.min(this.backoffMs * 2, MAX_PROBE_BACKOFF_MS);
          return;
        }
        this.backoffMs = this.probeBackoffBaseMs;
      }
      const snapshot = await this.client.listFleet();
      if (!this.stopped && snapshot) {
        this.lastSnapshot = snapshot;
        this.unavailablePushPending = true;
        this.options.broadcast(FLEET_UPDATE_CHANNEL, snapshot);
        this.schedule(this.intervalMs);
        return;
      }
      // Poll failed (or we were stopped mid-flight): herdr went away.
      this.available = false;
      this.publishUnavailable();
      this.schedule(this.backoffMs);
      this.backoffMs = Math.min(this.backoffMs * 2, MAX_PROBE_BACKOFF_MS);
    } finally {
      this.running = false;
    }
  }

  private publishUnavailable(): void {
    this.lastSnapshot = { available: false, fetchedAt: Date.now(), workspaces: [] };
    if (!this.unavailablePushPending) return;
    this.unavailablePushPending = false;
    this.options.broadcast(FLEET_UPDATE_CHANNEL, this.lastSnapshot);
  }
}

/**
 * Cordis mount (same shape as runtime-plugins, registered as a service rather
 * than a runtime). Cleanup is tied to the context fiber: disposing the kernel
 * stops the loop.
 */
export function defineFleetPlugin(options: FleetServiceOptions): Plugin.Object<void> {
  return {
    name: 'fleet',
    apply(ctx: Context) {
      const service = new FleetService(ctx, options);
      ctx.effect(() => () => service.stop());
      service.start();
    },
  };
}
