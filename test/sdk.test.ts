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
import { DEFAULT_CONFIG, freshState, zeroUsage, type FusionState } from '../src/state.ts';
import { preferencesPath, readPreferences, writePreferences } from '../src/preferences.ts';

type Answer = { text?: string; tool?: { name: string; arguments: JsonObject }; error?: string };
async function harness(respond: (context: Context, options?: SimpleStreamOptions) => Promise<Answer> | Answer) {
  const dir = mkdtempSync(join(tmpdir(), 'pi-fusion-sdk-'));
  const runtime = await ModelRuntime.create({ modelsPath: null, authPath: join(dir, 'auth.json'), refreshOnCreate: false });
  let requests = 0;
  runtime.registerProvider('fusion-test', {
    baseUrl: 'http://unused.invalid', api: 'openai-completions', apiKey: 'offline-test-placeholder',
    models: [{ id: 'worker', name: 'Test worker', reasoning: false, input: ['text'],
      cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 }],
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream();
      requests++;
      void (async () => {
        const answer = await respond(context, options);
        const message: AssistantMessage = {
          role: 'assistant', provider: model.provider, model: model.id, api: model.api, timestamp: Date.now(),
          content: [], usage: { ...zeroUsage(), input: 12, output: 3, totalTokens: 15,
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
