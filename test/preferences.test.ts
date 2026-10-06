import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parsePreferences, preferencesPath, readPreferences, writePreferences,
} from '../src/preferences.ts';
import { DEFAULT_CONFIG, freshState, type FusionState } from '../src/state.ts';

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'pi-fusion-prefs-'));
  return { dir, file: preferencesPath(dir), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
const stored = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const parse = (config: unknown, enabled = false) => parsePreferences({ version: 1, enabled, config });
// parsePreferences delegates validation to the existing state layer, so accept its messages too.
const INVALID = /Invalid|Model must be an exact/;
const rejects = (run: () => unknown, pattern: RegExp = INVALID) => assert.throws(run, pattern);

test('absent defaults read as undefined and create nothing', () => {
  const w = workspace();
  try {
    assert.equal(readPreferences(w.dir), undefined);
    assert.deepEqual(readdirSync(w.dir), []);
  } finally { w.cleanup(); }
});

test('selected configuration round trips without session-scoped data or extra fields', () => {
  const w = workspace();
  try {
    const source = freshState();
    source.enabled = true;
    source.config.model = 'fusion-test/worker';
    source.config.thinking = 'high';
    source.config.tools = 'readonly';
    source.config.routing = 'jev';
    source.config.maxTurns = 12;
    source.config.timeoutMs = 120_000;
    source.config.reminders = false;
    // Session-scoped bookkeeping must never reach the global defaults.
    source.checkpoint = { file: '/fixture/child.jsonl', leaf: 'leaf' };
    source.last = { id: 'run', status: 'completed', startedAt: 1, endedAt: 2, report: 'done', usage: { ...source.pendingUsage }, claimed: true };
    source.routeAdvice = { recommendation: 'lead', choice: 'lead', confidence: .9, latencyMs: 3, reason: 'test' };
    source.routingUsage = { requests: 1, input: 2, output: 3 };
    source.pendingUsage = { ...source.pendingUsage, input: 7, totalTokens: 7, cost: { ...source.pendingUsage.cost, input: .5, total: .5 } };
    (source.config as unknown as Record<string, unknown>).sneaky = 'dropped';
    writePreferences(source, w.dir);
    const file = stored(w.file);
    assert.deepEqual(Object.keys(file).sort(), ['config', 'enabled', 'version']);
    assert.equal(file.version, 1);
    assert.equal(file.enabled, true);
    assert.deepEqual(Object.keys(file.config).sort(), ['maxTurns', 'model', 'reminders', 'routing', 'thinking', 'timeoutMs', 'tools']);
    assert.deepEqual(file.config, {
      model: 'fusion-test/worker', thinking: 'high', tools: 'readonly', routing: 'jev',
      maxTurns: 12, timeoutMs: 120_000, reminders: false,
    });
    const restored = readPreferences(w.dir)!;
    assert.deepEqual(restored, { version: 1, enabled: true, config: file.config });
  } finally { w.cleanup(); }
});

test('rewriting defaults persists the new on/off choice and leaves no temporary files', () => {
  const w = workspace();
  try {
    const first = freshState();
    first.enabled = true;
    first.config.model = 'fusion-test/worker';
    first.config.thinking = 'low';
    writePreferences(first, w.dir);
    const second = freshState();
    second.enabled = false;
    second.config.model = 'fusion-test/worker';
    second.config.thinking = 'low';
    writePreferences(second, w.dir);
    const file = stored(w.file);
    assert.equal(file.enabled, false);
    assert.equal(file.config.model, 'fusion-test/worker');
    assert.deepEqual(readdirSync(join(w.dir, 'fusion')).filter(name => name.includes('.tmp')), []);
    if (process.platform !== 'win32') {
      assert.equal(statSync(w.file).mode & 0o777, 0o600);
      assert.equal(statSync(join(w.dir, 'fusion')).mode & 0o777, 0o700);
    }
  } finally { w.cleanup(); }
});

test('onlyIfMissing never overwrites a concurrent creator', () => {
  const w = workspace();
  try {
    const mine = freshState();
    mine.enabled = true;
    mine.config.model = 'fusion-test/worker';
    mine.config.thinking = 'high';
    writePreferences(mine, w.dir);
    const before = readFileSync(w.file);
    const competing = freshState();
    competing.enabled = true;
    competing.config.model = 'other/model';
    competing.config.thinking = 'max';
    competing.config.tools = 'readonly';
    writePreferences(competing, w.dir, true);
    assert.deepEqual(readFileSync(w.file), before);
    assert.deepEqual(readdirSync(join(w.dir, 'fusion')).filter(name => name.includes('.tmp')), []);
  } finally { w.cleanup(); }
});

test('a corrupt, versioned or structurally invalid defaults file raises on read', () => {
  const w = workspace();
  try {
    mkdirSync(join(w.dir, 'fusion'), { recursive: true });
    const raws = ['{ not json', 'null', '"x"', '[]', '7'];
    for (const text of raws) {
      writeFileSync(w.file, text);
      rejects(() => readPreferences(w.dir), /Invalid|JSON/);
    }
    const invalid = (value: unknown, pattern: RegExp = INVALID) => {
      writeFileSync(w.file, JSON.stringify(value));
      rejects(() => readPreferences(w.dir), pattern);
    };
    invalid({ version: 2, enabled: false, config: {} });
    invalid({ version: 1, enabled: 'yes', config: {} });
    invalid({ version: 1, enabled: false, config: [] });
    invalid({ version: 1, enabled: false, config: 'x' });
    invalid({ version: 1, config: {} });
    invalid({ version: 1, enabled: true, config: {} });
    invalid({ version: 1, enabled: true, config: { model: 'fusion-test/worker', maxTurns: 0 } });
    invalid({ version: 1, enabled: true, config: { model: 'fusion-test/worker', maxTurns: 1001 } });
    invalid({ version: 1, enabled: true, config: { model: 'fusion-test/worker', timeoutMs: 240 * 60_000 + 1 } });
    invalid({ version: 1, enabled: true, config: { model: 'fusion-test/worker', timeoutMs: 59_999 } });
    invalid({ version: 1, enabled: false, config: { thinking: 'extreme' } });
    invalid({ version: 1, enabled: false, config: { tools: 'shell' } });
    invalid({ version: 1, enabled: false, config: { routing: 'jevs' } });
    // A rejected model surfaces either the preference guard or the existing parseModel message.
    for (const model of [null, 42, '', '/model', 'provider/', 'provider/model with space', {}]) {
      invalid({ version: 1, enabled: true, config: { model } }, /Invalid Fusion default model|Model must be an exact/);
    }
    // Unknown top-level keys are ignored; only the whitelisted fields are persisted.
    writeFileSync(w.file, JSON.stringify({ version: 1, enabled: false, config: {}, extra: 'ignored' }));
    assert.deepEqual(readPreferences(w.dir)!.config, DEFAULT_CONFIG);
  } finally { w.cleanup(); }
});

test('the boundary limits are inclusive and non-default enum values are rejected', () => {
  assert.deepEqual(parse({ timeoutMs: 240 * 60_000 }).config.timeoutMs, 240 * 60_000);
  assert.deepEqual(parse({ timeoutMs: 60_000 }).config.timeoutMs, 60_000);
  assert.deepEqual(parse({ maxTurns: 1000 }).config.maxTurns, 1000);
  rejects(() => parse({ timeoutMs: 240 * 60_000 + 1 }));
  rejects(() => parse({ timeoutMs: 59_999 }));
  rejects(() => parse({ maxTurns: 1001 }));
  rejects(() => parse({ maxTurns: 0 }));
  rejects(() => parse({ thinking: 'extreme' }));
  rejects(() => parse({ tools: 'shell' }));
  rejects(() => parse({ routing: 'jevs' }));
});

test('a partial defaults file keeps the documented initial defaults', () => {
  const parsed = parse({});
  assert.equal(parsed.version, 1);
  assert.equal(parsed.enabled, false);
  assert.equal('model' in parsed.config, false);
  assert.deepEqual(parsed.config, DEFAULT_CONFIG);
});

test('writing over a directory fails loudly and cleans the temporary file', () => {
  const w = workspace();
  try {
    mkdirSync(w.file, { recursive: true });
    const state = freshState();
    state.enabled = true;
    state.config.model = 'fusion-test/worker';
    assert.throws(() => writePreferences(state, w.dir));
    assert.equal(statSync(w.file).isDirectory(), true);
    assert.deepEqual(readdirSync(w.file), []);
    assert.deepEqual(readdirSync(join(w.dir, 'fusion')).filter(name => name.includes('.tmp')), []);
  } finally { w.cleanup(); }
});

test('enabled defaults without a model are rejected on write and create no file', () => {
  const w = workspace();
  try {
    const state: Pick<FusionState, 'enabled' | 'config'> = { enabled: true, config: { ...DEFAULT_CONFIG } };
    rejects(() => writePreferences(state, w.dir), /Invalid/);
    assert.equal(readPreferences(w.dir), undefined);
  } finally { w.cleanup(); }
});
