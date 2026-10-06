import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import {
  createAgentSession, DefaultResourceLoader, getAgentDir, ModelRuntime,
  SessionManager, SettingsManager,
  type ExtensionContext, type SessionEntry,
} from '@earendil-works/pi-coding-agent';
import type { SidekickDriver } from './controller.ts';
import { addUsage, zeroUsage, type Checkpoint, type FusionConfig } from './state.ts';
import { SIDEKICK_PROMPT, FIRST_HANDOFF, leadUpdate } from './prompts.ts';

export function sidekickDirectory(agentDir = getAgentDir()) { return resolve(agentDir, 'fusion', 'sessions'); }

export function openSidekick(cwd: string, directory: string, checkpoint?: Checkpoint): SessionManager {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!checkpoint) return SessionManager.create(cwd, directory);
  if (!existsSync(checkpoint.file)) throw new Error('Saved sidekick session is missing. Use /fusion reset to start a new one.');
  const path = realpathSync(checkpoint.file);
  const rel = relative(realpathSync(directory), path);
  if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw new Error('Sidekick checkpoint is outside the Fusion session directory.');
  const manager = SessionManager.open(path, directory);
  if (resolve(manager.getCwd()) !== resolve(cwd)) throw new Error('Sidekick workspace changed. Use /fusion reset in this workspace.');
  if (checkpoint.leaf === null) return SessionManager.create(cwd, directory);
  if (!manager.getEntry(checkpoint.leaf)) throw new Error('Saved sidekick checkpoint is missing from its transcript.');
  // A copy of exactly the saved branch prevents future context leaking across lead forks,
  // and prevents two restored parent sessions from appending to the same child file.
  manager.createBranchedSession(checkpoint.leaf);
  return manager;
}

export function usageForEntries(entries: SessionEntry[]) {
  return entries.reduce((sum, entry) => {
    const usage = entry.type === 'message' && 'usage' in entry.message ? entry.message.usage
      : entry.type === 'usage' || entry.type === 'compaction' || entry.type === 'branch_summary' ? entry.usage : undefined;
    return usage ? addUsage(sum, usage) : sum;
  }, zeroUsage());
}

export async function createSidekick(options: {
  ctx: Pick<ExtensionContext, 'cwd' | 'modelRegistry'>;
  config: FusionConfig;
  checkpoint?: Checkpoint;
  settings?: ReturnType<SettingsManager['getSettings']>;
  agentDir?: string;
}): Promise<SidekickDriver> {
  const { ctx, config } = options;
  if (!config.model) throw new Error('Choose a sidekick with /fusion model provider/model-id first.');
  const slash = config.model.indexOf('/');
  const providerId = config.model.slice(0, slash);
  const modelId = config.model.slice(slash + 1);
  const parentModel = ctx.modelRegistry.find(providerId, modelId);
  if (!parentModel || !ctx.modelRegistry.hasConfiguredAuth(parentModel)) throw new Error(`Model unavailable or not authenticated: ${config.model}`);
  const agentDir = options.agentDir ?? getAgentDir();
  const runtime = await ModelRuntime.create({ authPath: resolve(agentDir, 'auth.json'), modelsPath: resolve(agentDir, 'models.json') });
  // Copy only provider registrations, never execute the parent's extension factories.
  for (const id of ctx.modelRegistry.getRegisteredProviderIds()) {
    const native = ctx.modelRegistry.getRegisteredNativeProvider(id);
    const legacy = ctx.modelRegistry.getRegisteredProviderConfig(id);
    if (native) runtime.registerNativeProvider(native);
    if (legacy) runtime.registerProvider(id, legacy);
  }
  const model = runtime.getModel(providerId, modelId);
  if (!model) throw new Error(`Sidekick model could not be resolved: ${config.model}. Virtual model routers are not supported.`);
  const manager = openSidekick(ctx.cwd, sidekickDirectory(agentDir), options.checkpoint);
  const inherited = options.settings ?? {};
  const settings = SettingsManager.inMemory({
    // Carry runtime behavior, not resource lists or user default models.
    compaction: inherited.compaction,
    retry: inherited.retry ?? { enabled: true, maxRetries: 2 },
    shellPath: inherited.shellPath,
    shellCommandPrefix: inherited.shellCommandPrefix,
    transport: inherited.transport,
    httpIdleTimeoutMs: inherited.httpIdleTimeoutMs,
    cacheWarming: 'off',
    steeringMode: 'all',
  });
  const loader = new DefaultResourceLoader({
    cwd: ctx.cwd, agentDir, settingsManager: settings,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
    systemPrompt: SIDEKICK_PROMPT, appendSystemPromptOverride: () => [],
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd: ctx.cwd, agentDir, modelRuntime: runtime, model, thinkingLevel: config.thinking,
    resourceLoader: loader, settingsManager: settings, sessionManager: manager,
    tools: config.tools === 'readonly' ? ['read', 'grep', 'find', 'ls'] : ['read', 'grep', 'find', 'ls', 'edit', 'write', 'bash'],
  });
  await session.bindExtensions({ mode: 'json' });
  let current: Promise<unknown> | undefined;
  let ready: Promise<void> = Promise.resolve();
  let markReady = () => {};
  let callback: ((text: string) => void) | undefined;
  let activity: ((active: boolean) => void) | undefined;
  let turns = 0;
  let limitHit = false;
  let safeCheckpoint: Checkpoint | undefined = options.checkpoint;
  const captureCheckpoint = () => {
    const file = manager.getSessionFile();
    safeCheckpoint = file ? { file, leaf: manager.getLeafId() } : undefined;
  };
  captureCheckpoint();
  let priorIds = new Set<string>();
  const currentUsage = () => usageForEntries(manager.getBranch().filter(entry => !priorIds.has(entry.id)));
  const unsubscribe = session.subscribe(event => {
    if (event.type === 'agent_start') markReady();
    if (event.type === 'turn_start') activity?.(true);
    if (event.type === 'message_end' && event.message.role === 'assistant') activity?.(false);
    if (event.type === 'tool_execution_start') callback?.(`Running ${event.toolName}`);
    if (event.type === 'turn_end') {
      captureCheckpoint();
      turns++;
      callback?.(`Finished turn ${turns}`);
      if (turns >= config.maxTurns && ((event.message.role === 'assistant' && event.message.content.some(c => c.type === 'toolCall')) || session.getSteeringMessages().length > 0)) {
        limitHit = true;
        void session.abort().catch(() => {});
      }
    }
  });
  return {
    async run(message, onProgress, onActivity) {
      callback = onProgress;
      activity = onActivity;
      turns = 0;
      limitHit = false;
      priorIds = new Set(manager.getEntries().map(entry => entry.id));
      const priorMessages = session.messages.length;
      ready = new Promise(resolve => { markReady = resolve; });
      let failure: unknown;
      current = session.prompt(`${priorMessages === 0 ? FIRST_HANDOFF + '\n' : ''}<lead_handoff>\n${message}\n</lead_handoff>`, { expandPromptTemplates: false, source: 'extension' });
      try { await current; } catch (error) { failure = error; }
      finally { markReady(); current = undefined; callback = undefined; captureCheckpoint(); activity?.(false); activity = undefined; }
      const last = session.messages.slice(priorMessages).findLast(m => m.role === 'assistant');
      const text = last?.role === 'assistant' ? last.content.filter(c => c.type === 'text').map(c => c.text).join('\n') : '';
      const error = last?.role === 'assistant' && (last.stopReason === 'error' || last.stopReason === 'aborted' || last.stopReason === 'length')
        ? last.errorMessage ?? `Sidekick stopped: ${last.stopReason}` : undefined;
      const issue = failure ? String(failure) : limitHit ? 'Sidekick turn limit reached; incomplete work must be reviewed.' : error;
      const report = [issue, text || 'No final report was produced. Inspect the saved sidekick session.'].filter(Boolean).join('\n');
      return {
        report: report.length > 24_000 ? `${report.slice(0, 24_000)}\n[Report truncated; full output in ${manager.getSessionFile()}]` : report,
        failed: !!issue || !text,
        usage: currentUsage(),
      };
    },
    async steer(message) {
      if (!current) return false;
      await Promise.race([ready, current.catch(() => {})]);
      if (!current) return false;
      // During provider retry/compaction, steer is retained for the next request too.
      await session.steer(leadUpdate(message), undefined, { source: 'extension' });
      return true;
    },
    async abort() {
      if (current) await Promise.race([ready, current.catch(() => {})]);
      await session.abort();
      session.clearQueue();
    },
    usage: currentUsage,
    modelInfo: () => ({ model: `${session.model?.provider}/${session.model?.id}`, thinking: session.thinkingLevel }),
    checkpoint: () => safeCheckpoint,
    dispose() { unsubscribe(); session.dispose(); },
  };
}
