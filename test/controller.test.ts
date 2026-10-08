import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FusionController, type MaintenanceResult, type SidekickDriver, type DriverResult } from '../src/controller.ts';
import { freshState, zeroUsage } from '../src/state.ts';

function fixture(options: {
  assignModel?: (model: string) => Promise<void>;
  compact?: () => Promise<MaintenanceResult>;
} = {}) {
  const assignments: string[] = [];
  const state = freshState(); state.enabled = true;
  let finish: (result: DriverResult) => void = () => {};
  let creates = 0; let starts = 0; let aborts = 0; let disposed = 0;
  const updates: string[] = []; const notices: string[] = [];
  const driver: SidekickDriver = {
    run: () => { starts++; return new Promise(resolve => { finish = resolve; }); },
    steer: async message => { updates.push(message); return true; },
    abort: async () => { aborts++; finish({ report: 'partial evidence', failed: true, usage: zeroUsage() }); },
    checkpoint: () => ({ file: '/fixture/child.jsonl', leaf: 'leaf' }),
    assignModel: options.assignModel ?? (async (model: string) => { assignments.push(model); }),
    compact: options.compact ?? (async () => ({ usage: zeroUsage() })),
    dispose: () => { disposed++; },
  };
  const c = new FusionController(state, { create: async () => { creates++; return driver; }, changed: () => {}, completed: r => notices.push(r.id) });
  const complete = (report = 'done') => {
    const usage = zeroUsage(); usage.input = 10; usage.totalTokens = 10; usage.cost.input = .01; usage.cost.total = .01;
    finish({ report, failed: false, usage });
  };
  return { c, state, driver, updates, notices, assignments, complete, counts: () => ({ creates, starts, aborts, disposed }) };
}

test('concurrent handoffs create only one persistent sidekick and steer it', async () => {
  const f = fixture();
  const [a, b] = await Promise.all([f.c.dispatch('implement', true), f.c.dispatch('new requirement', true)]);
  assert.equal(a.run.id, b.run.id); assert.equal(b.steered, true);
  assert.deepEqual(f.counts(), { creates: 1, starts: 1, aborts: 0, disposed: 0 });
  assert.deepEqual(f.updates, ['new requirement']);
  const waiting = f.c.wait(1000); f.complete(); await waiting;
  await f.c.dispatch('follow-up', false);
  assert.equal(f.counts().creates, 1); assert.equal(f.counts().starts, 2);
  f.complete(); await f.c.wait(1000); await f.c.close();
});

test('blocking completion returns evidence without an extra wake; usage claimed once', async () => {
  const f = fixture(); await f.c.dispatch('work', false);
  const waiting = f.c.wait(1000); f.complete('tests pass');
  const result = await waiting;
  assert.equal(result.run?.report, 'tests pass'); assert.equal(result.run?.status, 'completed');
  assert.equal(f.notices.length, 0);
  assert.equal(f.c.claimUsage().totalTokens, 10); assert.equal(f.c.claimUsage().totalTokens, 0);
  await f.c.close();
});

test('a blocking read of background work consumes completion instead of waking twice', async () => {
  const f = fixture(); await f.c.dispatch('work', true);
  const waiting = f.c.wait(1000); f.complete(); await waiting;
  assert.equal(f.notices.length, 0);
  await f.c.close();
});

test('wait timeout leaves the task running and completion notifies exactly once', async () => {
  const f = fixture(); await f.c.dispatch('work', false);
  assert.equal((await f.c.wait(5)).timedOut, true); assert.equal(f.c.running, true);
  f.complete(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.notices.length, 1); await f.c.wait(1000); assert.equal(f.notices.length, 1);
  await f.c.close();
});

test('abort cancels work, preserves context, and does not wake the lead', async () => {
  const f = fixture(); await f.c.dispatch('work', false);
  const abort = new AbortController(); const wait = f.c.wait(1000, abort.signal); abort.abort();
  assert.equal((await wait).interrupted, true);
  await f.c.stop('cleanup');
  assert.equal(f.state.last?.status, 'cancelled'); assert.equal(f.state.checkpoint?.leaf, 'leaf');
  assert.equal(f.notices.length, 0); await f.c.close();
});

test('handoff deadline stops child; subsequent handoff can reuse its context', async () => {
  const f = fixture(); f.state.config.timeoutMs = 5;
  await f.c.dispatch('work', true); await f.c.wait(1000);
  assert.equal(f.state.last?.status, 'cancelled'); assert.match(f.state.last!.report, /time limit/);
  assert.equal(f.c.running, false); assert.equal(f.counts().aborts, 1); await f.c.close();
});

test('unread usage accumulates across consecutive handoffs', async () => {
  const f = fixture();
  for (let i = 0; i < 2; i++) { await f.c.dispatch('work', false); f.complete(); await f.c.wait(1000); }
  assert.equal(f.c.claimUsage().totalTokens, 20); assert.equal(f.c.claimUsage().totalTokens, 0);
  await f.c.close();
});

test('shutdown during lazy creation disposes the new child without starting it', async () => {
  const f = fixture();
  let ready: (driver: SidekickDriver) => void = () => {};
  let disposed = false;
  const state = freshState(); state.enabled = true;
  const c = new FusionController(state, { create: () => new Promise(resolve => { ready = resolve; }), changed() {}, completed() {} });
  const dispatch = c.dispatch('work', true);
  await new Promise(resolve => setImmediate(resolve));
  const close = c.close();
  ready({ run: async () => { throw Error('must not start'); }, steer: async () => false,
    abort: async () => {}, checkpoint: () => undefined, dispose: () => { disposed = true; } });
  await assert.rejects(dispatch, /closed/); await close; assert.equal(disposed, true);
  await f.c.close();
});

// ---------------------------------------------------------------------------
// Idle-only maintenance: assignment, compaction and cancellation.
// ---------------------------------------------------------------------------

function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const tokenUsage = (input: number) => {
  const usage = zeroUsage(); usage.input = input; usage.totalTokens = input; usage.cost.input = input / 1000; usage.cost.total = input / 1000;
  return usage;
};
const settled = (promise: Promise<unknown>) => promise.then(() => 'resolved', (error: Error) => `rejected:${error.message}`);
// The maintenance block only starts once the exclusive gate is free, so wait for entry.
function entered(): { promise: Promise<void>; mark: () => void } {
  let mark!: () => void;
  const promise = new Promise<void>(resolve => { mark = resolve; });
  return { promise, mark };
}

test('maintenance serializes with dispatch, bills once and never disposes the child', { timeout: 5000 }, async () => {
  const compact = deferred<MaintenanceResult>();
  const start = entered();
  const f = fixture({ compact: async () => { start.mark(); return compact.promise; } });
  try {
    const maintenance = f.c.compact();
    await start.promise;
    const queued = f.c.dispatch('followup brief', true);
    assert.equal(f.counts().starts, 0, 'a dispatch queued behind maintenance does not start');
    assert.equal(f.c.running, true);
    compact.resolve({ usage: tokenUsage(7) });
    await maintenance;
    assert.equal(await settled(queued), 'resolved');
    assert.equal(f.counts().starts, 1);
    assert.equal(f.counts().creates, 1);
    assert.equal(f.counts().disposed, 0);
    f.complete();
    await f.c.wait(1000);
    assert.equal(f.c.claimUsage().totalTokens, 17, 'the compacted summary is billed exactly once');
    assert.equal(f.c.claimUsage().totalTokens, 0);
  } finally {
    compact.resolve({ usage: tokenUsage(7) });
    await f.c.close();
  }
  assert.equal(f.counts().disposed, 1);
});

test('closing during maintenance rejects the queued dispatch and claims the summary usage once', { timeout: 5000 }, async () => {
  const compact = deferred<MaintenanceResult>();
  const start = entered();
  const f = fixture({ compact: async () => { start.mark(); return compact.promise; } });
  const maintenance = settled(f.c.compact());
  try {
    await start.promise;
    const queued = settled(f.c.dispatch('late brief', true));
    assert.equal(f.c.running, true);
    const closing = settled(f.c.close());
    compact.resolve({ usage: tokenUsage(7), error: 'cancelled' });
    assert.equal(await maintenance, 'rejected:cancelled');
    assert.equal(await closing, 'resolved');
    assert.equal(await queued, 'rejected:Fusion session is closed.');
    assert.equal(f.c.running, false);
    assert.equal(f.notices.length, 0, 'maintenance never wakes the lead');
    assert.equal(f.state.last, undefined);
    assert.equal(f.c.claimUsage().totalTokens, 7);
  } finally {
    compact.resolve({ usage: tokenUsage(7) });
    await f.c.close();
  }
  assert.equal(f.counts().disposed, 1);
});

test('stopping during maintenance cancels the queued dispatch instead of letting it escape', async () => {
  const compact = deferred<MaintenanceResult>();
  const start = entered();
  const f = fixture({ compact: async () => { start.mark(); return compact.promise; } });
  const maintenance = settled(f.c.compact());
  await start.promise;
  const queued = settled(f.c.dispatch('late brief', true));
  const stopping = settled(f.c.stop('Stopped by user.'));
  assert.equal(f.c.running, true);
  compact.resolve({ usage: tokenUsage(7), error: 'cancelled' });
  assert.equal(await maintenance, 'rejected:cancelled');
  assert.equal(await stopping, 'resolved');
  assert.equal(await queued, 'resolved', 'the queued dispatch runs and is then cancelled by the stop');
  assert.equal(f.c.running, false, 'no queued dispatch escapes the stop');
  assert.equal(f.notices.length, 0, 'a cancelled handoff does not wake the lead');
  assert.equal(f.state.last?.status, 'cancelled');
  assert.equal(f.counts().disposed, 0);
  await f.c.close();
  assert.equal(f.counts().disposed, 1);
});

test('a failed assignment leaves the branch state untouched', { timeout: 5000 }, async () => {
  const f = fixture({ assignModel: async () => { throw new Error('assignment fixture failure'); } });
  try {
    const first = await f.c.dispatch('brief', false);
    f.complete();
    await f.c.wait(1000);
    assert.equal(f.state.last?.status, 'completed', 'the first handoff settled before the assignment attempt');
    assert.equal(await settled(f.c.assignModel('fusion-test/worker-strong')), 'rejected:assignment fixture failure');
    assert.equal(f.counts().creates, 1, 'the child existed when the assignment failed');
    assert.equal(f.state.assignment, undefined, 'a failed assignment does not mutate the branch');
  } finally { await f.c.close(); }
  assert.equal(f.state.assignment, undefined, 'a failed assignment does not mutate the branch');
  const g = fixture();
  await g.c.assignModel('fusion-test/worker-strong');
  assert.deepEqual(g.state.assignment, { model: 'fusion-test/worker-strong' });
  assert.equal(g.state.config.model, undefined, 'assignment never becomes a default');
  assert.equal(g.counts().creates, 0, 'assignment before the child exists only records the pointer');
  await g.c.close();
});
