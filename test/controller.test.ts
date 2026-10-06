import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FusionController, type SidekickDriver, type DriverResult } from '../src/controller.ts';
import { freshState, zeroUsage } from '../src/state.ts';

function fixture() {
  const state = freshState(); state.enabled = true;
  let finish: (result: DriverResult) => void = () => {};
  let creates = 0; let starts = 0; let aborts = 0; let disposed = 0;
  const updates: string[] = []; const notices: string[] = [];
  const driver: SidekickDriver = {
    run: () => { starts++; return new Promise(resolve => { finish = resolve; }); },
    steer: async message => { updates.push(message); return true; },
    abort: async () => { aborts++; finish({ report: 'partial evidence', failed: true, usage: zeroUsage() }); },
    checkpoint: () => ({ file: '/fixture/child.jsonl', leaf: 'leaf' }),
    dispose: () => { disposed++; },
  };
  const c = new FusionController(state, { create: async () => { creates++; return driver; }, changed: () => {}, completed: r => notices.push(r.id) });
  const complete = (report = 'done') => {
    const usage = zeroUsage(); usage.input = 10; usage.totalTokens = 10; usage.cost.input = .01; usage.cost.total = .01;
    finish({ report, failed: false, usage });
  };
  return { c, state, updates, notices, complete, counts: () => ({ creates, starts, aborts, disposed }) };
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
