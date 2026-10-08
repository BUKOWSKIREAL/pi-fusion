import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createAssistantMessageEventStream, getCurrentTools,
  type AssistantMessage, type Context, type SimpleStreamOptions, type JsonObject,
} from '@earendil-works/pi-ai';
import { createAgentSession, DefaultResourceLoader, ModelRegistry, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import fusion from '../src/index.ts';
import { createSidekick, openSidekick, sidekickDirectory } from '../src/sidekick.ts';
import { type MaintenanceResult, type SidekickDriver } from '../src/controller.ts';
import { DEFAULT_CONFIG, freshState, zeroUsage, type FusionState } from '../src/state.ts';
import { preferencesPath, readPreferences, writePreferences } from '../src/preferences.ts';

type Answer = { text?: string; tool?: { name: string; arguments: JsonObject }; error?: string; usageInput?: number };
async function harness(respond: (context: Context, options?: SimpleStreamOptions, modelId?: string) => Promise<Answer> | Answer,
  limits: { contextWindow?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pi-fusion-sdk-'));
  const runtime = await ModelRuntime.create({ modelsPath: null, authPath: join(dir, 'auth.json'), refreshOnCreate: false });
  let requests = 0;
  const physical = [
    { id: 'worker', name: 'Test worker', reasoning: false },
    { id: 'worker-strong', name: 'Test worker strong', reasoning: false },
  ];
  runtime.registerProvider('fusion-test', {
    baseUrl: 'http://unused.invalid', api: 'openai-completions', apiKey: 'offline-test-placeholder',
    models: physical.map(({ id, name, reasoning }) => ({ id, name, reasoning, input: ['text'],
      cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, contextWindow: limits.contextWindow ?? 128000, maxTokens: 4096 })),
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream();
      requests++;
      void (async () => {
        const answer = await respond(context, options, model.id);
        const input = answer.usageInput ?? 12;
        const message: AssistantMessage = {
          role: 'assistant', provider: model.provider, model: model.id, api: model.api, timestamp: Date.now(),
          content: [], usage: { ...zeroUsage(), input, output: 3, totalTokens: input + 3,
            cost: { input: .000012, output: .000006, cacheRead: 0, cacheWrite: 0, total: .000018 } },
          stopReason: 'pending',
        };
        stream.push({ type: 'start', partial: message });
        if (options?.signal?.aborted || answer.error) {
          message.stopReason = options?.signal?.aborted ? 'aborted' : 'error'; message.errorMessage = answer.error ?? 'test aborted';
          stream.push({ type: 'error', reason: message.stopReason, error: message }); stream.end(); return;
        }
        if (answer.tool) {
          const call = { type: 'toolCall' as const, id: `call-${requests}`, ...answer.tool };
          message.content.push(call);
          stream.push({ type: 'toolcall_start', contentIndex: 0, partial: message });
          stream.push({ type: 'toolcall_end', contentIndex: 0, toolCall: call, partial: message });
          message.stopReason = 'toolUse';
        } else {
          const text = answer.text ?? 'done'; message.content.push({ type: 'text', text });
          stream.push({ type: 'text_start', contentIndex: 0, partial: message });
          stream.push({ type: 'text_delta', contentIndex: 0, delta: text, partial: message });
          stream.push({ type: 'text_end', contentIndex: 0, content: text, partial: message });
          message.stopReason = 'stop';
        }
        stream.push({ type: 'done', reason: message.stopReason, message }); stream.end();
      })().catch(error => { stream.end(); console.error(error); });
      return stream;
    },
  });
  const registry = new ModelRegistry(runtime);
  const options = { ctx: { cwd: dir, modelRegistry: registry }, agentDir: dir,
    config: { ...DEFAULT_CONFIG, model: 'fusion-test/worker' }, settings: { retry: { enabled: false } } };
  return { dir, runtime, options, requests: () => requests, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
const allText = (context: Context) => JSON.stringify(context.messages);
// One entry per independent Pi launch: a fresh loader and AgentSession on the same offline runtime.
type Launch = { session: Awaited<ReturnType<typeof createAgentSession>>['session']; manager: SessionManager };
async function closeLaunches(launches: Launch[]) {
  for (const { session } of launches.splice(0)) {
    await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
    session.dispose();
  }
}
const selectedConfig = (): FusionState['config'] => ({
  model: 'fusion-test/worker', thinking: 'high', tools: 'readonly',
  timeoutMs: 120_000, maxTurns: 12, reminders: false, routing: 'jev',
});
const fusionState = (manager: SessionManager): FusionState | undefined => manager.getBranch().flatMap(entry =>
  entry.type === 'custom' && entry.customType === 'pi-local-fusion/state' ? [entry.data as FusionState] : []).at(-1);
async function configure(h: Awaited<ReturnType<typeof harness>>, session: Awaited<ReturnType<typeof createAgentSession>>['session']) {
  for (const command of ['/fusion model fusion-test/worker', '/fusion thinking high', '/fusion tools readonly',
    '/fusion timeout 2', '/fusion turns 12', '/fusion reminders off']) await session.prompt(command);
  // The routing command only checks for the key; no routing request is made without a task prompt.
  const key = process.env.TYPESAFE_API_KEY;
  process.env.TYPESAFE_API_KEY = 'offline-test-placeholder';
  await session.prompt('/fusion routing jev');
  if (key === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = key;
}
function isolate(h: Awaited<ReturnType<typeof harness>>) {
  const agentDir = process.env.PI_CODING_AGENT_DIR;
  const jevKey = process.env.TYPESAFE_API_KEY;
  process.env.PI_CODING_AGENT_DIR = h.dir;
  delete process.env.TYPESAFE_API_KEY;
  return () => {
    if (agentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = agentDir;
    if (jevKey === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = jevKey;
  };
}

test('real SDK runs tools, retains context, restores checkpoints, excludes future branches', async () => {
  const contexts: Context[] = [];
  const h = await harness(context => {
    contexts.push(structuredClone(context));
    if (contexts.length === 1) return { tool: { name: 'write', arguments: { path: 'result.txt', content: 'from sidekick' } } };
    return { text: `verified-${contexts.length}` };
  });
  let driver = await createSidekick(h.options);
  try {
    const first = await driver.run('Remember ALPHA and write result.txt.', () => {});
    assert.equal(first.failed, false); assert.equal(first.usage.totalTokens, 30);
    assert.equal(readFileSync(join(h.dir, 'result.txt'), 'utf8'), 'from sidekick');
    const checkpoint = driver.checkpoint()!;
    assert.ok(checkpoint.leaf);
    await driver.run('Future BRANCH_BETA', () => {});
    assert.match(allText(contexts.at(-1)!), /ALPHA/);
    driver.dispose();
    driver = await createSidekick({ ...h.options, checkpoint });
    const second = await driver.run('Now BRANCH_GAMMA', () => {});
    assert.equal(second.failed, false);
    assert.match(allText(contexts.at(-1)!), /ALPHA/);
    assert.doesNotMatch(allText(contexts.at(-1)!), /BRANCH_BETA/);
    assert.notEqual(driver.checkpoint()?.file, checkpoint.file);
    const tools = getCurrentTools(contexts[0]!.messages).map(t => t.name);
    assert.deepEqual(tools.sort(), ['read', 'grep', 'find', 'ls', 'edit', 'write', 'bash'].sort());
    assert.ok(!tools.includes('sidekick'));
  } finally { driver.dispose(); h.cleanup(); }
});

test('running SDK sidekick consumes a steering message in the same conversation', async () => {
  let release = () => {}; let entered = () => {};
  const begun = new Promise<void>(r => { entered = r; });
  const gate = new Promise<void>(r => { release = r; });
  const contexts: Context[] = [];
  const h = await harness(async context => {
    contexts.push(structuredClone(context));
    if (contexts.length === 1) { entered(); await gate; return { text: 'initial response' }; }
    return { text: 'included updated requirement' };
  });
  const driver = await createSidekick(h.options);
  try {
    const run = driver.run('Initial brief', () => {});
    await begun;
    assert.equal(await driver.steer('NEW_REQUIREMENT'), true);
    release();
    const report = await run;
    assert.equal(report.failed, false); assert.match(report.report, /updated requirement/);
    assert.equal(contexts.length, 2); assert.match(allText(contexts[1]!), /NEW_REQUIREMENT/);
  } finally { release(); driver.dispose(); h.cleanup(); }
});

test('SDK cancellation retains the transcript and permits another handoff', async () => {
  let entered = () => {};
  const begun = new Promise<void>(r => { entered = r; });
  let calls = 0;
  const h = await harness(async (_context, options) => {
    if (++calls > 1) return { text: 'resumed' };
    entered();
    await new Promise<void>(resolve => options!.signal!.addEventListener('abort', () => resolve(), { once: true }));
    return { text: 'cancelled' };
  });
  const driver = await createSidekick(h.options);
  try {
    const run = driver.run('First attempt', () => {}); await begun;
    await driver.abort(); const cancelled = await run; assert.equal(cancelled.failed, true);
    assert.ok(driver.checkpoint()?.leaf);
    const resumed = await driver.run('Resume without repeating completed work', () => {});
    assert.equal(resumed.failed, false); assert.equal(resumed.report, 'resumed');
  } finally { driver.dispose(); h.cleanup(); }
});

test('readonly sidekick exposes no write, bash, orchestration or user tools', async () => {
  let tools: string[] = [];
  const h = await harness(context => { tools = getCurrentTools(context.messages).map(t => t.name); return { text: 'read only' }; });
  const driver = await createSidekick({ ...h.options, config: { ...h.options.config, tools: 'readonly' } });
  try { await driver.run('Inspect only', () => {}); assert.deepEqual(tools.sort(), ['read', 'grep', 'find', 'ls'].sort()); }
  finally { driver.dispose(); h.cleanup(); }
});

test('missing or unrelated checkpoint files are rejected without silently losing context', async () => {
  const h = await harness(() => ({ text: 'unused' }));
  try {
    assert.throws(() => openSidekick(h.dir, sidekickDirectory(h.dir), { file: join(h.dir, 'missing.jsonl'), leaf: 'x' }), /missing/);
    const outsider = join(h.dir, 'outside.jsonl'); writeFileSync(outsider, '{}');
    assert.throws(() => openSidekick(h.dir, sidekickDirectory(h.dir), { file: outsider, leaf: 'x' }), /outside/);
  } finally { h.cleanup(); }
});

test('turn limit stops a tool loop, and a final response at the exact limit is accepted', async () => {
  let calls = 0;
  const h = await harness((): Answer => ++calls === 1 ? { tool: { name: 'ls', arguments: { path: '.' } } } : { text: 'finished next handoff' });
  const driver = await createSidekick({ ...h.options, config: { ...h.options.config, maxTurns: 1 } });
  const activity: boolean[] = [];
  try {
    const limited = await driver.run('Inspect files', () => {}, value => activity.push(value));
    assert.equal(limited.failed, true); assert.match(limited.report, /turn limit/); assert.equal(calls, 1);
    assert.ok(activity.includes(true)); assert.equal(activity.at(-1), false);
    const final = await driver.run('Report only', () => {});
    assert.equal(final.failed, false); assert.equal(final.report, 'finished next handoff');
  } finally { driver.dispose(); h.cleanup(); }
});

test('provider error cannot return a previous handoff report as success', async () => {
  let calls = 0;
  const h = await harness(() => ++calls === 1 ? { text: 'previous success' } : { error: 'fixture provider failed' });
  const driver = await createSidekick(h.options);
  try {
    await driver.run('first', () => {});
    const failed = await driver.run('second', () => {});
    assert.equal(failed.failed, true); assert.match(failed.report, /fixture provider failed/);
    assert.doesNotMatch(failed.report, /previous success/);
  } finally { driver.dispose(); h.cleanup(); }
});

test('extension end-to-end: off by default, delegates, returns evidence and accounts usage once', async () => {
  let parentCalls = 0;
  const seen: Context[] = [];
  const h = await harness((context): Answer => {
    seen.push(structuredClone(context));
    const names = getCurrentTools(context.messages).map(t => t.name);
    if (!names.includes('sidekick')) return { text: 'sidekick evidence report' };
    parentCalls++;
    if (parentCalls === 1) return { tool: { name: 'sidekick', arguments: { message: 'Collect evidence', block: true } } };
    if (parentCalls === 2) return { tool: { name: 'read_sidekick', arguments: { block: false } } };
    return { text: 'lead reviewed evidence' };
  });
  const previous = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = h.dir;
  const loader = new DefaultResourceLoader({ cwd: h.dir, agentDir: h.dir, noExtensions: true, noSkills: true,
    noPromptTemplates: true, noThemes: true, extensionFactories: [fusion] });
  let session: Awaited<ReturnType<typeof createAgentSession>>['session'] | undefined;
  try {
    await loader.reload();
    ({ session } = await createAgentSession({ cwd: h.dir, agentDir: h.dir, modelRuntime: h.runtime,
      model: h.runtime.getModel('fusion-test', 'worker'), resourceLoader: loader,
      sessionManager: SessionManager.inMemory(h.dir), settingsManager: SettingsManager.inMemory({ retry: { enabled: false } }) }));
    await session.bindExtensions({ mode: 'json' });
    assert.ok(!session.getActiveToolNames().includes('sidekick'));
    await session.prompt('/fusion model fusion-test/worker');
    assert.ok(session.getActiveToolNames().includes('sidekick'));
    await session.prompt('Do the task');
    assert.equal(session.getLastAssistantText(), 'lead reviewed evidence');
    const tools = session.messages.filter(m => m.role === 'toolResult');
    assert.equal(tools[0]?.usage?.totalTokens, 15);
    assert.equal(tools[1]?.usage?.totalTokens, 0);
    assert.ok(seen.some(c => allText(c).includes('Sidekick') && allText(c).includes('Specify the code')));
    await session.prompt('/fusion off');
    assert.ok(!session.getActiveToolNames().includes('sidekick'));
  } finally {
    await session?.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
    session?.dispose();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    h.cleanup();
  }
});

test('background completion wakes the lead once and keeps original lead instructions', { timeout: 8000 }, async () => {
  let release = () => {}; const gate = new Promise<void>(r => { release = r; });
  let parentCalls = 0;
  let completed = () => {}; const done = new Promise<void>(r => { completed = r; });
  const wakeContexts: Context[] = [];
  const h = await harness(async (context): Promise<Answer> => {
    const names = getCurrentTools(context.messages).map(t => t.name);
    if (!names.includes('sidekick')) { await gate; return { text: 'background evidence' }; }
    parentCalls++;
    if (parentCalls === 1) return { tool: { name: 'sidekick', arguments: { message: 'Background evidence', block: false } } };
    if (parentCalls === 2) return { text: 'Doing independent lead work' };
    wakeContexts.push(structuredClone(context));
    if (parentCalls === 3) return { tool: { name: 'read_sidekick', arguments: { block: true } } };
    return { text: 'background reviewed' };
  });
  const previous = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = h.dir;
  const loader = new DefaultResourceLoader({ cwd: h.dir, agentDir: h.dir, noExtensions: true, noSkills: true,
    noPromptTemplates: true, noThemes: true, extensionFactories: [fusion] });
  let session: Awaited<ReturnType<typeof createAgentSession>>['session'] | undefined;
  try {
    await loader.reload();
    ({ session } = await createAgentSession({ cwd: h.dir, agentDir: h.dir, modelRuntime: h.runtime,
      model: h.runtime.getModel('fusion-test', 'worker'), resourceLoader: loader,
      sessionManager: SessionManager.inMemory(h.dir), settingsManager: SettingsManager.inMemory({ retry: { enabled: false } }) }));
    await session.bindExtensions({ mode: 'json' });
    session.subscribe(event => { if (event.type === 'agent_settled' && parentCalls >= 4) completed(); });
    await session.prompt('/fusion model fusion-test/worker');
    await session.prompt('Start background work');
    assert.equal(parentCalls, 2);
    release(); await done;
    assert.equal(parentCalls, 4);
    assert.match(allText(wakeContexts[0]!), /Specify the code/);
    assert.equal(session.getLastAssistantText(), 'background reviewed');
    assert.equal(session.messages.filter(m => m.role === 'toolResult').find(m => m.toolName === 'read_sidekick')?.usage?.totalTokens, 15);
  } finally {
    release();
    await session?.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
    session?.dispose();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    h.cleanup();
  }
});

test('new sessions inherit global defaults, and explicit commands persist them', async () => {
  const h = await harness((): Answer => ({ text: 'unused' }));
  const restore = isolate(h);
  const launches: Launch[] = [];
  try {
    const open = async (manager = SessionManager.inMemory(h.dir), cwd = h.dir) => {
      const loader = new DefaultResourceLoader({ cwd, agentDir: h.dir, noExtensions: true, noSkills: true,
        noPromptTemplates: true, noThemes: true, extensionFactories: [fusion] });
      await loader.reload();
      const { session } = await createAgentSession({ cwd, agentDir: h.dir, modelRuntime: h.runtime,
        model: h.runtime.getModel('fusion-test', 'worker'), resourceLoader: loader, sessionManager: manager,
        settingsManager: SettingsManager.inMemory({ retry: { enabled: false } }) });
      await session.bindExtensions({ mode: 'json' });
      launches.push({ session, manager });
      return session;
    };
    const first = await open();
    assert.ok(!first.getActiveToolNames().includes('sidekick'));
    await configure(h, first);
    const chosen = fusionState(launches[0]!.manager)!;
    assert.equal(chosen.enabled, true);
    assert.deepEqual(chosen.config, selectedConfig());
    assert.deepEqual(readPreferences(h.dir)!.config, selectedConfig());
    await closeLaunches(launches);

    const second = await open();
    assert.ok(second.getActiveToolNames().includes('sidekick'));
    const inherited = fusionState(launches[0]!.manager)!;
    assert.equal(inherited.enabled, true);
    assert.deepEqual(inherited.config, selectedConfig());
    assert.equal(inherited.checkpoint, undefined);
    assert.equal(inherited.last, undefined);
    assert.equal(inherited.routeAdvice, undefined);
    assert.equal(inherited.routingUsage, undefined);
    assert.deepEqual(inherited.pendingUsage, zeroUsage());
    assert.equal(h.requests(), 0);
  } finally { await closeLaunches(launches); restore(); h.cleanup(); }
});

test('explicit off persists for later sessions while reset, stop and status leave defaults untouched', async () => {
  const h = await harness((): Answer => ({ text: 'unused' }));
  const restore = isolate(h);
  const launches: Launch[] = [];
  try {
    const open = async (manager = SessionManager.inMemory(h.dir), cwd = h.dir) => {
      const loader = new DefaultResourceLoader({ cwd, agentDir: h.dir, noExtensions: true, noSkills: true,
        noPromptTemplates: true, noThemes: true, extensionFactories: [fusion] });
      await loader.reload();
      const { session } = await createAgentSession({ cwd, agentDir: h.dir, modelRuntime: h.runtime,
        model: h.runtime.getModel('fusion-test', 'worker'), resourceLoader: loader, sessionManager: manager,
        settingsManager: SettingsManager.inMemory({ retry: { enabled: false } }) });
      await session.bindExtensions({ mode: 'json' });
      launches.push({ session, manager });
      return session;
    };
    const file = preferencesPath(h.dir);
    const first = await open();
    await configure(h, first);
    await first.prompt('/fusion off');
    assert.equal(readPreferences(h.dir)!.enabled, false);
    const disabled = readFileSync(file);
    await closeLaunches(launches);

    const second = await open();
    assert.ok(!second.getActiveToolNames().includes('sidekick'));
    const inherited = fusionState(launches[0]!.manager)!;
    assert.equal(inherited.enabled, false);
    assert.deepEqual(inherited.config, selectedConfig());
    assert.deepEqual(readFileSync(file), disabled, 'a saved session must not rewrite defaults');
    const before = readFileSync(file);
    await second.prompt('/fusion on');
    const enabled = readFileSync(file);
    assert.notDeepEqual(enabled, before);
    assert.equal(readPreferences(h.dir)!.enabled, true);
    for (const command of ['/fusion reset', '/fusion stop', '/fusion status']) {
      await second.prompt(command);
      assert.deepEqual(readFileSync(file), enabled, command);
    }
    assert.equal(h.requests(), 0);
  } finally { await closeLaunches(launches); restore(); h.cleanup(); }
});

test('a saved branch state wins over global defaults and never rewrites them', async () => {
  const h = await harness((): Answer => ({ text: 'unused' }));
  const restore = isolate(h);
  const launches: Launch[] = [];
  try {
    const saved = freshState();
    saved.enabled = false;
    saved.config.model = 'fusion-test/worker';
    saved.config.thinking = 'low';
    saved.config.routing = 'off';
    const manager = SessionManager.inMemory(h.dir);
    manager.appendCustomEntry('pi-local-fusion/state', saved);
    writePreferences({ enabled: true, config: { ...saved.config, thinking: 'high', routing: 'jev' } }, h.dir);
    const before = readFileSync(preferencesPath(h.dir));

    const loader = new DefaultResourceLoader({ cwd: h.dir, agentDir: h.dir, noExtensions: true, noSkills: true,
      noPromptTemplates: true, noThemes: true, extensionFactories: [fusion] });
    await loader.reload();
    const { session } = await createAgentSession({ cwd: h.dir, agentDir: h.dir, modelRuntime: h.runtime,
      model: h.runtime.getModel('fusion-test', 'worker'), resourceLoader: loader, sessionManager: manager,
      settingsManager: SettingsManager.inMemory({ retry: { enabled: false } }) });
    await session.bindExtensions({ mode: 'json' });
    launches.push({ session, manager });
    assert.ok(!session.getActiveToolNames().includes('sidekick'));
    const current = fusionState(manager)!;
    assert.equal(current.enabled, false);
    assert.equal(current.config.thinking, 'low');
    assert.equal(current.config.routing, 'off');
    assert.equal(current.config.model, 'fusion-test/worker');
    assert.deepEqual(readFileSync(preferencesPath(h.dir)), before);
    await closeLaunches(launches);
    assert.deepEqual(readFileSync(preferencesPath(h.dir)), before);
    assert.equal(h.requests(), 0);
  } finally { await closeLaunches(launches); restore(); h.cleanup(); }
});

test('reloading a legacy configured session migrates its preferences exactly once', async () => {
  const h = await harness((): Answer => ({ text: 'unused' }));
  const restore = isolate(h);
  const launches: Launch[] = [];
  try {
    const legacy = freshState();
    legacy.enabled = true;
    legacy.config.model = 'fusion-test/worker';
    legacy.config.thinking = 'xhigh';
    legacy.config.tools = 'readonly';
    legacy.config.timeoutMs = 120_000;
    legacy.config.maxTurns = 12;
    legacy.config.reminders = false;
    const manager = SessionManager.inMemory(h.dir);
    manager.appendCustomEntry('pi-local-fusion/state', legacy);

    const loader = new DefaultResourceLoader({ cwd: h.dir, agentDir: h.dir, noExtensions: true, noSkills: true,
      noPromptTemplates: true, noThemes: true, extensionFactories: [fusion] });
    await loader.reload();
    const { session } = await createAgentSession({ cwd: h.dir, agentDir: h.dir, modelRuntime: h.runtime,
      model: h.runtime.getModel('fusion-test', 'worker'), resourceLoader: loader, sessionManager: manager,
      settingsManager: SettingsManager.inMemory({ retry: { enabled: false } }) });
    await session.bindExtensions({ mode: 'json' });
    launches.push({ session, manager });
    assert.ok(session.getActiveToolNames().includes('sidekick'));

    const persisted = JSON.parse(readFileSync(preferencesPath(h.dir), 'utf8'));
    assert.deepEqual(Object.keys(persisted).sort(), ['config', 'enabled', 'version']);
    assert.equal(persisted.enabled, true);
    assert.deepEqual(persisted.config, legacy.config);
    assert.equal(persisted.checkpoint, undefined);
    assert.equal(persisted.last, undefined);
    assert.equal(persisted.routeAdvice, undefined);
    assert.equal(persisted.routingUsage, undefined);
    const migrated = readFileSync(preferencesPath(h.dir));
    await closeLaunches(launches);
    assert.deepEqual(readFileSync(preferencesPath(h.dir)), migrated, 'migration must not repeat');
    assert.equal(h.requests(), 0);
  } finally { await closeLaunches(launches); restore(); h.cleanup(); }
});

test('a corrupt defaults file leaves Fusion usable and repairs on model selection', async () => {
  const h = await harness((): Answer => ({ text: 'unused' }));
  const restore = isolate(h);
  const launches: Launch[] = [];
  try {
    const file = preferencesPath(h.dir);
    mkdirSync(join(h.dir, 'fusion'), { recursive: true });
    writeFileSync(file, '{ not json');
    const open = async () => {
      const manager = SessionManager.inMemory(h.dir);
      const loader = new DefaultResourceLoader({ cwd: h.dir, agentDir: h.dir, noExtensions: true, noSkills: true,
        noPromptTemplates: true, noThemes: true, extensionFactories: [fusion] });
      await loader.reload();
      const { session } = await createAgentSession({ cwd: h.dir, agentDir: h.dir, modelRuntime: h.runtime,
        model: h.runtime.getModel('fusion-test', 'worker'), resourceLoader: loader, sessionManager: manager,
        settingsManager: SettingsManager.inMemory({ retry: { enabled: false } }) });
      await session.bindExtensions({ mode: 'json' });
      launches.push({ session, manager });
      return session;
    };
    const first = await open();
    assert.ok(!first.getActiveToolNames().includes('sidekick'));
    assert.equal(readFileSync(file, 'utf8'), '{ not json', 'a corrupt file must not be silently rewritten on start');
    await first.prompt('/fusion model fusion-test/worker');
    const repaired = readPreferences(h.dir)!;
    assert.equal(repaired.enabled, true);
    assert.equal(repaired.config.model, 'fusion-test/worker');
    assert.deepEqual(repaired.config, { ...DEFAULT_CONFIG, model: 'fusion-test/worker' });
    await closeLaunches(launches);

    // Saved Jev routing survives a launch without the key; the router falls back without any paid call.
    writePreferences({ enabled: true, config: { ...repaired.config, routing: 'jev' } }, h.dir);
    const second = await open();
    const current = fusionState(launches[0]!.manager)!;
    assert.equal(current.config.routing, 'jev');
    assert.equal(current.enabled, true);
    assert.ok(second.getActiveToolNames().includes('sidekick'));
    assert.equal(process.env.TYPESAFE_API_KEY, undefined);
    assert.equal(h.requests(), 0);
  } finally { await closeLaunches(launches); restore(); h.cleanup(); }
});

// ---------------------------------------------------------------------------
// Runtime slice: branch-local assignment and Pi scheduled compaction.
// ---------------------------------------------------------------------------

type RuntimeHarness = Awaited<ReturnType<typeof harness>>;
// A concrete driver: the optional maintenance members exist on the real child driver.
type RuntimeDriver = SidekickDriver & {
  assignModel(model: string): Promise<void>;
  compact(): Promise<MaintenanceResult>;
  modelInfo(): { model: string; thinking: string };
};
function inspect(h: RuntimeHarness, checkpoint: { file: string }) {
  return SessionManager.open(checkpoint.file, sidekickDirectory(h.dir));
}
// Providers see the folded system prompt as the leading message, not Context.systemPrompt.
const isSummaryRequest = (context: Context) => allText(context).includes('context summarization assistant');
// Raw message text, for exact multiline comparisons that JSON escaping would break.
const providerText = (context: Context) => context.messages.flatMap(message => typeof message.content === 'string'
  ? [message.content] : message.content.filter(block => block.type === 'text').map(block => block.text)).join('\n');
const compactionEntries = (manager: SessionManager) => manager.getBranch().filter(entry => entry.type === 'compaction');
const readonlyCompaction = { enabled: false, reserveTokens: 4096, keepRecentTokens: 1 } as const;

test('assigning a physical model keeps the persistent child and restores to its file', async () => {
  const contexts: Context[] = [];
  const h = await harness((context, _options, modelId): Answer => {
    contexts.push(structuredClone(context));
    return contexts.filter(c => !isSummaryRequest(c)).length === 1
      ? { tool: { name: 'write', arguments: { path: 'keep.txt', content: 'ALPHA_EXACT' } } }
      : { text: `handled by ${modelId}`, usageInput: 12 };
  });
  const driver = (await createSidekick(h.options)) as RuntimeDriver;
  try {
    await driver.run('Remember ALPHA_EXACT and write keep.txt.', () => {});
    assert.equal(driver.modelInfo().model, 'fusion-test/worker');
    const checkpoint = driver.checkpoint()!;
    assert.ok(checkpoint.leaf);
    const file = checkpoint.file;

    await driver.assignModel('fusion-test/worker-strong');
    assert.equal(driver.modelInfo().model, 'fusion-test/worker-strong');
    assert.equal(driver.modelInfo().thinking, 'off', 'the fixture model has reasoning:false');
    assert.equal(driver.checkpoint()!.file, file, 'the persistent child file is unchanged');
    assert.ok(inspect(h, { file }).getBranch().some(entry => entry.type === 'model_change' && entry.modelId === 'worker-strong'));

    const second = await driver.run('Continue with ALPHA.', () => {});
    assert.equal(second.failed, false);
    assert.equal(second.report, 'handled by worker-strong');
    assert.match(allText(contexts.at(-1)!), /ALPHA_EXACT/);
    assert.match(allText(contexts.at(-1)!), /keep\.txt/);

    await assert.rejects(() => driver.assignModel('bogus'), /provider\/model-id/);
    await assert.rejects(() => driver.assignModel('fusion-test/missing'), /Physical sidekick model unavailable/);
    assert.equal(driver.modelInfo().model, 'fusion-test/worker-strong');
    assert.equal(driver.checkpoint()!.file, file);

    const busy = driver.run('Continue again.', () => {});
    await assert.rejects(() => driver.assignModel('fusion-test/worker'), /Stop the active sidekick before changing its assignment/);
    assert.equal(driver.modelInfo().model, 'fusion-test/worker-strong');
    await busy;
    assert.equal(second.usage.totalTokens, 15);

    // The pre-assignment checkpoint excludes the later branch and its model change.
    const earlier = (await createSidekick({ ...h.options, checkpoint })) as RuntimeDriver;
    try {
      assert.equal(earlier.modelInfo().model, 'fusion-test/worker');
      assert.notEqual(earlier.checkpoint()!.file, file, 'a restored child is branched into a new file');
      assert.ok(!inspect(h, earlier.checkpoint()!).getBranch().some(entry => entry.type === 'model_change' && entry.modelId === 'worker-strong'));
      const third = await earlier.run('Resume after restore.', () => {});
      assert.equal(third.failed, false);
      assert.equal(third.report, 'handled by worker');
      assert.doesNotMatch(allText(contexts.at(-1)!), /worker-strong/);
    } finally { earlier.dispose(); }
  } finally { driver.dispose(); h.cleanup(); }
});

test('compacting before any handoff keeps the checkpoint empty and the child usable', async () => {
  const h = await harness((context): Answer => isSummaryRequest(context) ? { text: 'offline summary' } : { text: 'later report' });
  const driver = (await createSidekick({ ...h.options,
    settings: { retry: { enabled: false }, compaction: readonlyCompaction } })) as RuntimeDriver;
  try {
    const empty = await driver.compact();
    assert.match(empty.error!, /Nothing to compact/);
    assert.equal(empty.usage.totalTokens, 0);
    assert.equal(h.requests(), 0, 'no summary request is made when there is nothing to compact');
    assert.equal(driver.checkpoint(), undefined, 'a file that was never flushed is not persisted');
    const run = await driver.run('Do the work.', () => {});
    assert.equal(run.failed, false);
    assert.equal(run.report, 'later report');
    assert.ok(driver.checkpoint()!.leaf);
  } finally { driver.dispose(); h.cleanup(); }
});

test('manual compaction pins the original handoff once and bills its summary once', async () => {
  const contexts: Context[] = [];
  let ordinary = 0;
  let summaries = 0;
  const h = await harness((context): Answer => {
    contexts.push(structuredClone(context));
    if (isSummaryRequest(context)) { summaries++; return { text: 'offline summary' }; }
    if (++ordinary === 1) return { tool: { name: 'write', arguments: { path: 'persisted.txt', content: 'ALPHA' } } };
    return { text: ordinary === 3 ? 'second report' : ordinary === 4 ? 'third report' : 'first report' };
  });
  const driver = (await createSidekick({ ...h.options,
    settings: { retry: { enabled: false }, compaction: readonlyCompaction } })) as RuntimeDriver;
  try {
    const brief = 'Brief: add CSV export.\n\n```sql\nselect 1;\n```\nPreserve ALPHA punctuation.';
    const first = await driver.run(brief, () => {});
    assert.equal(first.failed, false);
    assert.equal(first.report, 'first report');
    assert.equal(first.usage.totalTokens, 30, 'both turns of the run are counted');
    const file = driver.checkpoint()!.file;
    const originalCheckpoint = driver.checkpoint()!;

    const compacted = await driver.compact();
    assert.equal(compacted.error, undefined);
    const firstSummaries = summaries;
    assert.ok(firstSummaries >= 1, 'the summary is requested at least once (a split turn uses two)');
    assert.equal(compacted.usage.totalTokens, 15 * firstSummaries, 'every summary request is ledgered');
    const branch = inspect(h, { file });
    assert.equal(compactionEntries(branch).length, 1);
    assert.equal(branch.getBranch().filter(e => e.type === 'usage').length, firstSummaries);
    assert.equal(readFileSync(join(h.dir, 'persisted.txt'), 'utf8'), 'ALPHA');

    const second = await driver.run('BRIEF_TWO: check the diff.', () => {});
    assert.equal(second.failed, false);
    assert.equal(second.report, 'second report');
    assert.equal(second.usage.totalTokens, 15);
    const after = providerText(contexts.at(-1)!);
    assert.equal(after.split(brief).length - 1, 1, 'the original handoff text appears exactly once');
    assert.match(after, /offline summary/);
    assert.match(after, /select 1;/);

    const again = await driver.compact();
    assert.equal(again.error, undefined);
    assert.equal(again.usage.totalTokens, 15 * (summaries - firstSummaries), 'the second compaction bills its own summaries');
    const third = await driver.run('BRIEF_THREE: finish.', () => {});
    assert.equal(third.failed, false);
    assert.equal(third.report, 'third report');
    const latest = providerText(contexts.at(-1)!);
    assert.equal(latest.split(brief).length - 1, 1, 'a second compaction keeps exactly one copy');
    assert.equal(driver.checkpoint()!.file, file);
    assert.equal(compactionEntries(inspect(h, { file })).length, 2);
    assert.equal(first.usage.totalTokens + second.usage.totalTokens + third.usage.totalTokens
      + compacted.usage.totalTokens + again.usage.totalTokens, h.requests() * 15, 'no double charge');

    // The branch before any compaction excludes the later briefs and their summaries.
    const details = inspect(h, { file }).getBranch().filter(e => e.type === 'compaction').at(-1)!;
    const compactionDetails = details.details as { modifiedFiles: string[]; fusion: { version: number; handoffEntryIds: string[] } };
    assert.equal(compactionDetails.fusion.version, 1);
    assert.ok(compactionDetails.modifiedFiles.some(path => path.endsWith('persisted.txt')), 'compaction records the edited file');
    assert.ok(compactionDetails.fusion.handoffEntryIds.length >= 1, 'the pinned handoff entry is recorded');
    for (const entry of inspect(h, { file }).getBranch().filter(e => e.type === 'compaction')) {
      assert.equal(entry.usage, undefined, 'the ledger, not the entry, bills the summary');
    }
    const replayed = (await createSidekick({ ...h.options, checkpoint: originalCheckpoint })) as RuntimeDriver;
    try {
      const replay = await replayed.run('BRIEF_FOUR: verify.', () => {});
      assert.equal(replay.failed, false);
      const replayContext = allText(contexts.at(-1)!);
      assert.match(replayContext, /Brief: add CSV export/);
      assert.doesNotMatch(replayContext, /BRIEF_TWO/);
      assert.doesNotMatch(replayContext, /BRIEF_THREE/);
    } finally { replayed.dispose(); }
  } finally { driver.dispose(); h.cleanup(); }
});


test('a failing summary attempt keeps the original context and is billed once', { timeout: 5000 }, async () => {
  const contexts: Context[] = [];
  const h = await harness((context): Answer => {
    contexts.push(structuredClone(context));
    if (isSummaryRequest(context)) return { error: 'summary fixture failure' };
    return { text: 'succeeding report' };
  });
  const driver = (await createSidekick({ ...h.options,
    settings: { retry: { enabled: false }, compaction: readonlyCompaction } })) as RuntimeDriver;
  try {
    const brief = 'Brief: keep this exact text.\nSecond line.';
    const first = await driver.run(brief, () => {});
    assert.equal(first.failed, false);
    const ledger = () => inspect(h, { file: driver.checkpoint()!.file }).getBranch().filter(e => e.type === 'usage').length;
    const before = ledger();
    const compacted = await driver.compact();
    assert.match(compacted.error!, /summary fixture failure/);
    assert.equal(compacted.usage.totalTokens, 15, 'the failed attempt still reports its usage');
    assert.equal(ledger(), before + 1, 'exactly one ledger entry for the failed attempt');
    assert.equal(compactionEntries(inspect(h, { file: driver.checkpoint()!.file })).length, 0, 'no compaction is applied');
    const second = await driver.run('Follow-up brief.', () => {});
    assert.equal(second.failed, false);
    const after = providerText(contexts.at(-1)!);
    assert.match(after, /keep this exact text/);
    assert.doesNotMatch(after, /offline summary/);
  } finally { driver.dispose(); h.cleanup(); }
});

test('cancelling a summary attempt settles without deadlock and keeps the child usable', { timeout: 5000 }, async () => {
  let begun = () => {}; const started = new Promise<void>(r => { begun = r; });
  let release = () => {}; const gate = new Promise<void>(r => { release = r; });
  const h = await harness(async (context, options): Promise<Answer> => {
    if (isSummaryRequest(context)) {
      begun();
      await Promise.race([gate, new Promise<void>(resolve => options!.signal!.addEventListener('abort', () => resolve(), { once: true }))]);
      return { error: 'aborted summary' };
    }
    return { text: 'after cancellation' };
  });
  const driver = (await createSidekick({ ...h.options,
    settings: { retry: { enabled: false }, compaction: readonlyCompaction } })) as RuntimeDriver;
  try {
    await driver.run('Brief before cancellation.', () => {});
    const compacting = driver.compact();
    await started;
    await driver.abort();
    const compacted = await compacting;
    assert.ok(compacted.error !== undefined, 'the cancelled attempt reports an error');
    assert.equal(compacted.usage.totalTokens, 15, 'reported cancelled-summary usage is preserved');
    assert.equal(compactionEntries(inspect(h, { file: driver.checkpoint()!.file })).length, 0, 'no compaction is applied');
    const run = await driver.run('Brief after cancellation.', () => {});
    assert.equal(run.failed, false);
    assert.equal(run.report, 'after cancellation');
  } finally { release(); driver.dispose(); h.cleanup(); }
});

test('automatic threshold compaction pins the handoff and keeps the report accurate', { timeout: 8000 }, async () => {
  const contexts: Context[] = [];
  const h = await harness((context): Answer => {
    contexts.push(structuredClone(context));
    if (isSummaryRequest(context)) return { text: 'offline summary' };
    return contexts.filter(c => !isSummaryRequest(c)).length === 1
      ? { tool: { name: 'ls', arguments: { path: '.' } }, usageInput: 125_000 }
      : { text: 'fresh final report' };
  });
  const driver = (await createSidekick({ ...h.options,
    settings: { retry: { enabled: false }, compaction: { enabled: true, reserveTokens: 4096, keepRecentTokens: 1 } } })) as RuntimeDriver;
  try {
    const run = await driver.run('AUTO_HANDOFF_EXACT: list the directory.', () => {});
    assert.equal(run.failed, false);
    assert.equal(run.report, 'fresh final report', 'the report is the newest response, not a pre-compaction one');
    assert.match(providerText(contexts.at(-1)!), /AUTO_HANDOFF_EXACT/);
    assert.equal(run.usage.totalTokens, 125_003 + 15 * (h.requests() - 1),
      'every work and summary request is billed before the handoff settles');
    const branch = inspect(h, { file: driver.checkpoint()!.file });
    assert.equal(compactionEntries(branch).length, 1, 'the threshold compaction was applied');
    assert.ok(branch.getBranch().filter(e => e.type === 'usage').length >= 1, 'the summary is ledgered');
    assert.equal(h.requests(), 3, 'two work turns and one summary request');
  } finally { driver.dispose(); h.cleanup(); }
});

test('compaction stops instead of dropping the handoff when the pinned text cannot fit', { timeout: 8000 }, async () => {
  const contexts: Context[] = [];
  const h = await harness((context): Answer => {
    contexts.push(structuredClone(context));
    if (isSummaryRequest(context)) return { text: 'offline summary' };
    return { text: 'ordinary report' };
  }, { contextWindow: 5_000 });
  const driver = (await createSidekick({ ...h.options,
    settings: { retry: { enabled: false }, compaction: { enabled: false, reserveTokens: 4096, keepRecentTokens: 1 } } })) as RuntimeDriver;
  try {
    const brief = 'Brief that must be preserved.';
    await driver.run(brief, () => {});
    const compacted = await driver.compact();
    assert.match(compacted.error!, /Compacted context with pinned handoffs exceeds/);
    assert.equal(compacted.usage.totalTokens, 15, 'the full-context guard includes the system prompt after summarizing');
    assert.equal(h.requests(), 2, 'one work request and one summary request');
    assert.equal(compactionEntries(inspect(h, { file: driver.checkpoint()!.file })).length, 0, 'no compaction is applied');
    const run = await driver.run('Follow-up.', () => {});
    assert.equal(run.failed, false);
    assert.match(providerText(contexts.at(-1)!), /Brief that must be preserved/);
  } finally { driver.dispose(); h.cleanup(); }
});

test('delivered steering survives compaction while an aborted queued update does not', { timeout: 5000 }, async () => {
  let release = () => {};
  let entered = () => {};
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const contexts: Context[] = [];
  let blockNext = true;
  const h = await harness(async (context, options): Promise<Answer> => {
    if (isSummaryRequest(context)) return { text: 'offline summary' };
    contexts.push(structuredClone(context));
    if (blockNext) {
      blockNext = false;
      entered();
      await Promise.race([gate, new Promise<void>(resolve => {
        if (options?.signal?.aborted) resolve();
        else options?.signal?.addEventListener('abort', () => resolve(), { once: true });
      })]);
    }
    return { text: 'steering report' };
  });
  const driver = await createSidekick({ ...h.options,
    settings: { retry: { enabled: false }, compaction: readonlyCompaction } }) as RuntimeDriver;
  try {
    const run = driver.run('First brief.', () => {});
    await started;
    const update = 'NEW_REQUIREMENT\nKeep `price >= 0` exactly.';
    assert.equal(await driver.steer(update), true);
    release();
    assert.equal((await run).failed, false);
    assert.equal((await driver.compact()).error, undefined);
    assert.equal((await driver.run('Review the result.', () => {})).failed, false);
    assert.equal(providerText(contexts.at(-1)!).split(update).length - 1, 1);
  } finally { release(); driver.dispose(); h.cleanup(); }

  let begun = () => {};
  const pending = new Promise<void>(resolve => { begun = resolve; });
  let first = true;
  let lastContext: Context | undefined;
  const cancelled = await harness(async (context, options): Promise<Answer> => {
    if (isSummaryRequest(context)) return { text: 'offline summary' };
    lastContext = structuredClone(context);
    if (first) {
      first = false; begun();
      await new Promise<void>(resolve => options!.signal!.addEventListener('abort', () => resolve(), { once: true }));
    }
    return { text: 'after abort' };
  });
  const child = await createSidekick({ ...cancelled.options,
    settings: { retry: { enabled: false }, compaction: readonlyCompaction } }) as RuntimeDriver;
  try {
    const run = child.run('Original delivered brief.', () => {});
    await pending;
    await child.steer('NEVER_DELIVERED_UPDATE');
    await child.abort();
    await run;
    await child.run('Resume.', () => {});
    assert.equal((await child.compact()).error, undefined);
    await child.run('Inspect preserved context.', () => {});
    assert.doesNotMatch(providerText(lastContext!), /NEVER_DELIVERED_UPDATE/);
  } finally { await child.abort(); child.dispose(); cancelled.cleanup(); }
});

test('assignment and compact commands preserve defaults, restore branches, and claim summary usage once', { timeout: 8000 }, async () => {
  let action: 'delegate' | 'read' | undefined;
  const childModels: string[] = [];
  const h = await harness((context, _options, modelId): Answer => {
    if (isSummaryRequest(context)) return { text: 'offline summary' };
    if (!getCurrentTools(context.messages).some(tool => tool.name === 'sidekick')) {
      childModels.push(modelId!);
      return { text: 'child report' };
    }
    const next = action; action = undefined;
    if (next === 'delegate') return { tool: { name: 'sidekick', arguments: { message: 'COMMAND_BRIEF', block: true } } };
    if (next === 'read') return { tool: { name: 'read_sidekick', arguments: { block: false } } };
    return { text: 'reviewed' };
  });
  const restore = isolate(h);
  const launches: Launch[] = [];
  const open = async (manager = SessionManager.inMemory(h.dir)) => {
    const settings = SettingsManager.inMemory({ retry: { enabled: false }, compaction: readonlyCompaction });
    const loader = new DefaultResourceLoader({ cwd: h.dir, agentDir: h.dir, settingsManager: settings,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, extensionFactories: [fusion] });
    await loader.reload();
    const { session } = await createAgentSession({ cwd: h.dir, agentDir: h.dir, modelRuntime: h.runtime,
      model: h.runtime.getModel('fusion-test', 'worker'), resourceLoader: loader, sessionManager: manager, settingsManager: settings });
    await session.bindExtensions({ mode: 'json' });
    launches.push({ session, manager });
    return { session, manager };
  };
  try {
    const first = await open();
    await first.session.prompt('/fusion model fusion-test/worker');
    const defaults = readFileSync(preferencesPath(h.dir), 'utf8');
    await first.session.prompt('/fusion assign fusion-test/worker-strong');
    assert.deepEqual(fusionState(first.manager)!.assignment, { model: 'fusion-test/worker-strong' });
    assert.equal(readFileSync(preferencesPath(h.dir), 'utf8'), defaults);
    action = 'delegate';
    await first.session.prompt('Run the brief.');
    assert.deepEqual(childModels, ['worker-strong']);
    const file = fusionState(first.manager)!.checkpoint!.file;
    const before = h.requests();
    await first.session.prompt('/fusion compact');
    const charged = (h.requests() - before) * 15;
    assert.ok(charged > 0);
    assert.equal(fusionState(first.manager)!.pendingUsage.totalTokens, charged);
    assert.equal(fusionState(first.manager)!.checkpoint!.file, file);
    action = 'read'; await first.session.prompt('Read the report.');
    const lastToolUsage = () => first.session.messages.filter(message => message.role === 'toolResult').at(-1)!.usage!.totalTokens;
    assert.equal(lastToolUsage(), charged);
    action = 'read'; await first.session.prompt('Read once more.');
    assert.equal(lastToolUsage(), 0);
    assert.equal(readFileSync(preferencesPath(h.dir), 'utf8'), defaults);
    const saved = first.manager;
    await closeLaunches(launches);
    const resumed = await open(saved);
    assert.deepEqual(fusionState(saved)!.assignment, { model: 'fusion-test/worker-strong' });
    const fresh = await open();
    assert.equal(fusionState(fresh.manager)!.assignment, undefined);
    assert.equal(fusionState(fresh.manager)!.config.model, 'fusion-test/worker');
    const requests = h.requests();
    await resumed.session.prompt('/fusion model fusion-test/worker-strong');
    assert.equal(readPreferences(h.dir)!.config.model, 'fusion-test/worker-strong');
    assert.equal(fusionState(saved)!.assignment, undefined);
    await resumed.session.prompt('/fusion assign fusion-test/worker');
    await resumed.session.prompt('/fusion reset');
    assert.equal(fusionState(saved)!.assignment, undefined);
    assert.equal(fusionState(saved)!.checkpoint, undefined);
    assert.equal(readPreferences(h.dir)!.config.model, 'fusion-test/worker-strong');
    assert.equal((JSON.parse(readFileSync(preferencesPath(h.dir), 'utf8')) as Record<string, unknown>).assignment, undefined);
    assert.equal(h.requests(), requests, 'configuration commands make no model requests');
  } finally { await closeLaunches(launches); restore(); h.cleanup(); }
});

// ---------------------------------------------------------------------------
// Simplified settings flow: /fusion opens the picker first, then a short menu.
// ---------------------------------------------------------------------------

type SelectCall = { title: string; options: string[] };
function scriptedUI(session: Awaited<ReturnType<typeof createAgentSession>>['session'], script: (string | undefined)[]) {
  const selects: SelectCall[] = [];
  const notices: string[] = [];
  const base = session.extensionRunner.createContext().ui;
  const ui = {
    ...base,
    select: async (title: string, options: string[]) => {
      selects.push({ title, options: [...options] });
      assert.ok(script.length > 0, 'unexpected extra dialog');
      return script.shift();
    },
    notify: (message: string, type?: string) => { notices.push(`${type ?? 'info'}:${message}`); },
  };
  session.extensionRunner.setUIContext(ui, 'rpc');
  return { selects, notices };
}

test('first /fusion opens the picker directly, then the short settings menu', { timeout: 15000 }, async () => {
  const h = await harness((): Answer => ({ text: 'unused' }));
  const restore = isolate(h);
  const launches: Launch[] = [];
  try {
    const open = async () => {
      const loader = new DefaultResourceLoader({ cwd: h.dir, agentDir: h.dir, noExtensions: true, noSkills: true,
        noPromptTemplates: true, noThemes: true, extensionFactories: [fusion] });
      await loader.reload();
      const { session } = await createAgentSession({ cwd: h.dir, agentDir: h.dir, modelRuntime: h.runtime,
        model: h.runtime.getModel('fusion-test', 'worker'), resourceLoader: loader,
        sessionManager: SessionManager.inMemory(h.dir), settingsManager: SettingsManager.inMemory({ retry: { enabled: false } }) });
      await session.bindExtensions({ mode: 'json' });
      launches.push({ session, manager: session.sessionManager });
      return session;
    };
    const first = await open();
    const ui = scriptedUI(first, ['fusion-test/worker']);
    await first.prompt('/fusion');
    assert.equal(ui.selects.length, 1, 'the first /fusion goes straight to the picker');
    assert.match(ui.selects[0]!.title, /Choose sidekick model/);
    assert.deepEqual(ui.selects[0]!.options.sort(), ['fusion-test/worker', 'fusion-test/worker-strong']);
    const defaults = readPreferences(h.dir)!;
    assert.equal(defaults.enabled, true);
    assert.equal(defaults.config.model, 'fusion-test/worker');
    assert.ok(first.getActiveToolNames().includes('sidekick'));
    assert.match(ui.notices.at(-1)!, /Fusion on/);
    assert.match(ui.notices.at(-1)!, /Sidekick: fusion-test\/worker/);

    // The settings view shows the model and a toggle, not the advanced commands.
    const settings = scriptedUI(first, [undefined]);
    await first.prompt('/fusion');
    assert.equal(settings.selects.length, 1);
    const menu = settings.selects[0]!;
    assert.match(menu.title, /Fusion · On/);
    assert.deepEqual(menu.options, ['Sidekick model: fusion-test/worker', 'Turn off', 'View details']);
    const bytes = readFileSync(preferencesPath(h.dir));

    // Turning off and on again needs no picker.
    const off = scriptedUI(first, ['Turn off']);
    await first.prompt('/fusion');
    assert.equal(off.selects.length, 1, 'no picker is opened for the toggle');
    assert.equal(readPreferences(h.dir)!.enabled, false);
    assert.match(off.notices.at(-1)!, /Fusion off/);
    const offBytes = readFileSync(preferencesPath(h.dir));

    const on = scriptedUI(first, ['Turn on']);
    await first.prompt('/fusion');
    assert.equal(on.selects.length, 1);
    assert.equal(readPreferences(h.dir)!.enabled, true);
    assert.match(on.notices.at(-1)!, /Fusion on/);
    assert.notDeepEqual(readFileSync(preferencesPath(h.dir)), offBytes);
    assert.ok(first.getActiveToolNames().includes('sidekick'));

    // Escaping the picker keeps the saved defaults byte-for-byte.
    const escape = scriptedUI(first, [undefined]);
    await first.prompt('/fusion-model');
    assert.equal(escape.selects.length, 1, '/fusion-model opens the picker');
    assert.deepEqual(readFileSync(preferencesPath(h.dir)), bytes, 'escaping the picker changes nothing');
    assert.equal(readPreferences(h.dir)!.config.model, 'fusion-test/worker');

    // /fusion model with no identifier opens the same picker.
    const explicit = scriptedUI(first, [undefined]);
    await first.prompt('/fusion model');
    assert.equal(explicit.selects.length, 1, '/fusion model with no argument opens the picker');
    assert.match(explicit.selects[0]!.title, /Choose sidekick model/);
    assert.deepEqual(readFileSync(preferencesPath(h.dir)), bytes, 'escaping changes nothing');
    assert.equal(h.requests(), 0);
  } finally { await closeLaunches(launches); restore(); h.cleanup(); }
});

test('settings flow recovers when no model is available and lists advanced commands', { timeout: 15000 }, async () => {
  const h = await harness((): Answer => ({ text: 'unused' }));
  const restore = isolate(h);
  const launches: Launch[] = [];
  try {
    const open = async () => {
      const loader = new DefaultResourceLoader({ cwd: h.dir, agentDir: h.dir, noExtensions: true, noSkills: true,
        noPromptTemplates: true, noThemes: true, extensionFactories: [fusion] });
      await loader.reload();
      const { session } = await createAgentSession({ cwd: h.dir, agentDir: h.dir, modelRuntime: h.runtime,
        model: h.runtime.getModel('fusion-test', 'worker'), resourceLoader: loader,
        sessionManager: SessionManager.inMemory(h.dir), settingsManager: SettingsManager.inMemory({ retry: { enabled: false } }) });
      await session.bindExtensions({ mode: 'json' });
      launches.push({ session, manager: session.sessionManager });
      return session;
    };
    const session = await open();
    // A virtual candidate must never be offered as a sidekick.
    const registry = session.extensionRunner.createContext().modelRegistry;
    const getAvailable = registry.getAvailable;
    const original = getAvailable.call(registry);
    const virtual = { ...original[0]!, api: 'pi-virtual' as const, id: 'router', name: 'Virtual router' };
    registry.getAvailable = () => [...original, virtual as never];
    const ui = scriptedUI(session, ['fusion-test/worker']);
    await session.prompt('/fusion-model');
    assert.deepEqual(ui.selects[0]!.options.sort(), ['fusion-test/worker', 'fusion-test/worker-strong']);
    registry.getAvailable = getAvailable;

    // Empty model list: a friendly warning, no picker and no state change.
    const empty = scriptedUI(session, [undefined]);
    registry.getAvailable = () => [];
    await session.prompt('/fusion-model');
    assert.equal(empty.selects.length, 0);
    assert.match(empty.notices.at(-1)!, /No sidekick models are available/);
    registry.getAvailable = getAvailable;
    assert.equal(readPreferences(h.dir)!.enabled, true);

    // /fusion on with no saved default opens the picker instead of erroring.
    rmSync(preferencesPath(h.dir), { force: true });
    const fresh = await open();
    const picker = scriptedUI(fresh, [undefined]);
    await fresh.prompt('/fusion on');
    assert.equal(picker.selects.length, 1, 'a missing model opens the picker');
    assert.equal(readPreferences(h.dir), undefined, 'escaping the picker writes nothing');
    const chosen = scriptedUI(fresh, ['fusion-test/worker-strong']);
    await fresh.prompt('/fusion on');
    assert.equal(chosen.selects.length, 1);
    assert.equal(readPreferences(h.dir)!.enabled, true);
    assert.equal(readPreferences(h.dir)!.config.model, 'fusion-test/worker-strong');
    assert.ok(fresh.getActiveToolNames().includes('sidekick'));

    // Unknown subcommands give one short recovery line; help lists the advanced set.
    const unknown = scriptedUI(session, [undefined]);
    await session.prompt('/fusion nonsense');
    assert.match(unknown.notices.at(-1)!, /Unknown Fusion command/);
    const help = scriptedUI(session, [undefined]);
    await session.prompt('/fusion help');
    const text = help.notices.at(-1)!;
    assert.match(text, /\/fusion assign provider\/model-id/);
    assert.match(text, /\/fusion compact/);
    assert.match(text, /Advanced \(optional\)/);

    // Without a UI, /fusion prints a short summary rather than a usage wall.
    session.extensionRunner.setUIContext(undefined, 'json');
    const noUI = session.extensionRunner.getUIContext();
    const notify = noUI.notify;
    const notifications: string[] = [];
    noUI.notify = message => { notifications.push(message); };
    try {
      assert.equal(session.extensionRunner.hasUI(), false);
      await session.prompt('/fusion');
      assert.match(notifications.at(-1)!, /Fusion on/);
      assert.match(notifications.at(-1)!, /Use \/fusion help/);
      assert.doesNotMatch(notifications.at(-1)!, /Advanced|on\|off|assign provider/);
    } finally { noUI.notify = notify; }
    assert.equal(h.requests(), 0);
  } finally { await closeLaunches(launches); restore(); h.cleanup(); }
});
