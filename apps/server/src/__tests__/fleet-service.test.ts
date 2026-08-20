import { Context } from 'cordis';
import { afterAll, describe, expect, it } from 'vitest';
import type { FleetSnapshot } from '@ev/contracts';
import { FLEET_UPDATE_CHANNEL, FleetService, defineFleetPlugin } from '../herdr/fleet-service';

/** Client stub driven by the tests: probe/listFleet/readPane behavior is mutable. */
function fakeClient(
  initial: {
    probe: boolean;
    snapshot: FleetSnapshot | null;
    /** Value readPane resolves to; null simulates pane-closed/herdr-down. */
    paneOutput?: string | null;
  } = { probe: false, snapshot: null }
) {
  const state = {
    probe: initial.probe,
    snapshot: initial.snapshot,
    paneOutput: initial.paneOutput ?? null,
    probeCalls: 0,
    listCalls: 0,
    readCalls: 0,
    lastReadArgs: null as { paneId: string; lines: number | undefined } | null,
  };
  return {
    state,
    client: {
      probe: async () => {
        state.probeCalls += 1;
        return state.probe;
      },
      listFleet: async () => {
        state.listCalls += 1;
        return state.snapshot;
      },
      readPane: async (paneId: string, lines?: number) => {
        state.readCalls += 1;
        state.lastReadArgs = { paneId, lines };
        return state.paneOutput;
      },
    },
  };
}

function fleetSnapshot(workspaces: number): FleetSnapshot {
  return {
    available: true,
    fetchedAt: 123,
    workspaces: Array.from({ length: workspaces }, (_, index) => ({
      workspaceId: `w${index + 1}`,
      tabs: [],
    })),
  };
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

const contexts: Context[] = [];

function createService(options: {
  probe: boolean;
  snapshot?: FleetSnapshot | null;
  intervalMs?: number;
  probeBackoffMs?: number;
}) {
  const pushes: Array<{ channel: string; payload: FleetSnapshot }> = [];
  const context = new Context();
  contexts.push(context);
  const fake = fakeClient({ probe: options.probe, snapshot: options.snapshot ?? null });
  const service = new FleetService(context, {
    broadcast: (channel, payload) => pushes.push({ channel, payload: payload as FleetSnapshot }),
    client: fake.client,
    intervalMs: options.intervalMs ?? 20,
    probeBackoffMs: options.probeBackoffMs ?? 20,
  });
  return { service, pushes, fake };
}

afterAll(async () => {
  for (const service of contexts.map(context => context.fleet)) service?.stop();
  await Promise.allSettled(contexts.splice(0).map(context => context.fiber.dispose()));
});

describe('FleetService polling and degradation', () => {
  it('unavailable herdr: pushes {available:false} exactly once, keeps probing', async () => {
    const { service, pushes, fake } = createService({ probe: false });
    service.start();
    await sleep(150);
    service.stop();

    expect(fake.state.probeCalls).toBeGreaterThanOrEqual(2);
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toEqual({
      channel: FLEET_UPDATE_CHANNEL,
      payload: expect.objectContaining({ available: false, workspaces: [] }),
    });
  });

  it('available herdr: polls list-class commands only and pushes every snapshot', async () => {
    const { service, pushes, fake } = createService({ probe: true, snapshot: fleetSnapshot(2) });
    service.start();
    await sleep(130);
    service.stop();

    expect(fake.state.listCalls).toBeGreaterThanOrEqual(2);
    expect(pushes.length).toBeGreaterThanOrEqual(2);
    for (const push of pushes) {
      expect(push.channel).toBe(FLEET_UPDATE_CHANNEL);
      expect(push.payload.available).toBe(true);
      expect(push.payload.workspaces.map(workspace => workspace.workspaceId)).toEqual(['w1', 'w2']);
    }
    expect(service.snapshot().workspaces).toHaveLength(2);
  });

  it('recovery and loss: state transitions push once per direction', async () => {
    const { service, pushes, fake } = createService({ probe: false });
    service.start();
    await sleep(80);
    // herdr comes up.
    fake.state.probe = true;
    fake.state.snapshot = fleetSnapshot(1);
    await sleep(120);
    expect(pushes.filter(push => push.payload.available)).not.toHaveLength(0);
    const availablePushes = pushes.length;

    // herdr goes away: one unavailable push, then silence while probing.
    fake.state.probe = false;
    fake.state.snapshot = null;
    await sleep(150);
    service.stop();

    const unavailablePushes = pushes.filter(push => !push.payload.available);
    expect(unavailablePushes).toHaveLength(2); // initial + transition
    expect(pushes.length).toBeLessThanOrEqual(availablePushes + 1);
  });

  it('stop() freezes the push stream', async () => {
    const { service, pushes } = createService({ probe: true, snapshot: fleetSnapshot(1) });
    service.start();
    await sleep(80);
    service.stop();
    const count = pushes.length;
    await sleep(100);
    expect(pushes.length).toBe(count);
  });

  it('snapshot() before any fetch reports unavailable without a fetch timestamp', () => {
    const { service } = createService({ probe: false });
    expect(service.snapshot()).toEqual({ available: false, fetchedAt: 0, workspaces: [] });
  });
});

describe('FleetService.readPane (on-demand, never polled)', () => {
  it('delegates to the client and returns the raw output on success', async () => {
    const { service, fake } = createService({ probe: true, snapshot: fleetSnapshot(1) });
    fake.state.paneOutput = 'line1\nline2';
    const result = await service.readPane('w1:p1', 60);
    expect(result).toEqual({ ok: true, output: 'line1\nline2' });
    expect(fake.state.readCalls).toBe(1);
    expect(fake.state.lastReadArgs).toEqual({ paneId: 'w1:p1', lines: 60 });
  });

  it('passes through an undefined line count (server default applies downstream)', async () => {
    const { service, fake } = createService({ probe: true, snapshot: fleetSnapshot(1) });
    fake.state.paneOutput = 'x';
    await service.readPane('w1:p1');
    expect(fake.state.lastReadArgs).toEqual({ paneId: 'w1:p1', lines: undefined });
  });

  it('treats an empty string as a successful empty pane (not an error)', async () => {
    const { service, fake } = createService({ probe: true, snapshot: fleetSnapshot(1) });
    fake.state.paneOutput = '';
    const result = await service.readPane('w1:p1');
    expect(result).toEqual({ ok: true, output: '' });
  });

  it('maps a null client result (pane closed / herdr down) to an explicit error', async () => {
    const { service, fake } = createService({ probe: true, snapshot: fleetSnapshot(1) });
    fake.state.paneOutput = null;
    const result = await service.readPane('w1:p1');
    expect(result.ok).toBe(false);
    expect(result.output).toBeUndefined();
    expect(result.error).toBeTruthy();
  });

  it('never calls readPane from the polling loop', async () => {
    const { service, fake } = createService({ probe: true, snapshot: fleetSnapshot(1) });
    service.start();
    await sleep(130);
    service.stop();
    // Several polls happened, but readPane stays untouched until explicitly invoked.
    expect(fake.state.listCalls).toBeGreaterThanOrEqual(2);
    expect(fake.state.readCalls).toBe(0);
    await service.readPane('w1:p1');
    expect(fake.state.readCalls).toBe(1);
  });
});

describe('defineFleetPlugin', () => {
  it('registers the fleet service on the cordis context and stops on dispose', async () => {
    const pushes: unknown[] = [];
    const context = new Context();
    const fake = fakeClient({ probe: true, snapshot: fleetSnapshot(1) });
    await context.plugin(
      defineFleetPlugin({
        broadcast: (channel, payload) => pushes.push({ channel, payload }),
        client: fake.client,
        intervalMs: 20,
      })
    );
    expect(context.fleet).toBeInstanceOf(FleetService);
    await sleep(80);
    expect(pushes.length).toBeGreaterThanOrEqual(1);

    await context.fiber.dispose();
    const count = pushes.length;
    await sleep(80);
    expect(pushes.length).toBe(count);
  });
});
