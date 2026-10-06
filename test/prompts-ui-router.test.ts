import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { visibleWidth } from '@earendil-works/pi-tui';
import { LEAD_PROMPT, SIDEKICK_PROMPT, TOOL_DESCRIPTION, FIRST_MESSAGE_REMINDER, renderTemplate } from '../src/prompts.ts';
import { fusionLines } from '../src/display.ts';
import { routeWithJev } from '../src/router.ts';
import { freshState, restoreState } from '../src/state.ts';

test('original prompt artifacts match extraction manifest, adapters resolve every placeholder', () => {
  const root = new URL('../resources/devin-original/', import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL('manifest.json', root), 'utf8'));
  assert.equal(manifest.version_directory, '3000.11.3');
  for (const span of manifest.spans) {
    const bytes = readFileSync(new URL(span.file, root));
    assert.equal(bytes.length, span.length);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), span.sha256);
  }
  for (const prompt of [LEAD_PROMPT, SIDEKICK_PROMPT, TOOL_DESCRIPTION, FIRST_MESSAGE_REMINDER]) {
    assert.doesNotMatch(prompt, /\{[A-Z_]+\}/);
    assert.doesNotMatch(prompt, /\u0000/);
  }
  assert.match(LEAD_PROMPT, /Specify the code, don't describe it/);
  assert.match(SIDEKICK_PROMPT, /You are the Sidekick subagent of Devin/);
  assert.match(TOOL_DESCRIPTION, /wait for it with `read_sidekick`/);
  assert.throws(() => renderTemplate('{UNKNOWN}', {}), /Unresolved/);
});

test('both models are visible and light independently; narrow layouts fit terminal width', () => {
  const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
  };
  const base = { lead: 'codex/gpt-6-astra', leadThinking: 'xhigh', sidekick: 'provider/worker', sidekickThinking: 'medium' };
  for (const leadActive of [false, true]) for (const sidekickActive of [false, true]) {
    const lines = fusionLines({ ...base, leadActive, sidekickActive }, 150, theme);
    assert.ok(lines.join('').includes(`${leadActive ? '●' : '○'} codex/gpt-6-astra`));
    assert.ok(lines.join('').includes(`${sidekickActive ? '●' : '○'} provider/worker`));
    assert.equal((lines.join('').match(/\x1b\[1m/g) ?? []).length, Number(leadActive) + Number(sidekickActive));
    for (const width of [1, 20, 40, 80]) {
      const wrapped = fusionLines({ ...base, leadActive, sidekickActive, routing: 'Jev → lead · 300ms' }, width, theme);
      assert.ok(wrapped.every(line => visibleWidth(line) <= width));
    }
  }
});

test('Jev advice handles low confidence, uncertainty, bad responses and timeouts', async () => {
  const old = process.env.TYPESAFE_API_KEY; process.env.TYPESAFE_API_KEY = 'offline-test-placeholder';
  try {
    let calls = 0;
    const response = (choice: string, confidence: number, probabilities = { lead: .01, sidekick: .98, uncertain: .01 }): typeof fetch => async (_url, init) => {
      calls++;
      const body = JSON.parse(String(init?.body));
      assert.deepEqual(Object.keys(body.state).sort(), ['request', 'workflow']);
      return Response.json({ model: 'jev-test', answers: { next_owner: { type: 'choice', choice, confidence, probabilities } }, usage: { input_tokens: 10, output_tokens: 2 } });
    };
    assert.equal((await routeWithJev('run named tests', { fetch: response('sidekick', .98) })).recommendation, 'sidekick');
    assert.equal((await routeWithJev('ambiguous task', { fetch: response('sidekick', .7) })).recommendation, 'lead');
    assert.equal((await routeWithJev('continue', { fetch: response('uncertain', .9, { lead: .01, sidekick: .01, uncertain: .98 }) })).recommendation, 'lead');
    assert.equal((await routeWithJev('x', { fetch: response('unexpected', 1) })).choice, undefined);
    const unavailable: typeof fetch = async () => new Response('server error', { status: 503 });
    assert.match((await routeWithJev('x', { fetch: unavailable })).reason, /503/);
    const abort = new AbortController(); abort.abort();
    const aborted: typeof fetch = async (_url, init) => { init!.signal!.throwIfAborted(); throw Error('unreachable'); };
    assert.match((await routeWithJev('x', { fetch: aborted, signal: abort.signal })).reason, /cancelled/);
    assert.equal(calls, 4);
    const count = calls;
    await routeWithJev('x'.repeat(9000), { fetch: response('sidekick', 1) });
    assert.equal(calls, count);
    delete process.env.TYPESAFE_API_KEY;
    assert.match((await routeWithJev('x', { fetch: response('sidekick', 1) })).reason, /unavailable/);
    assert.equal(calls, count);
  } finally { if (old === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = old; }
});

test('crash recovery retains billed work so next report can account for it', () => {
  const state = freshState();
  const usage = structuredClone(state.pendingUsage); usage.totalTokens = 123;
  state.last = { id: 'old-run', status: 'running', startedAt: 1, report: '', usage, claimed: false };
  const restored = restoreState(state);
  assert.equal(restored.last?.status, 'cancelled');
  assert.equal(restored.pendingUsage.totalTokens, 123);
  assert.equal(restoreState(restored).pendingUsage.totalTokens, 123);
});
