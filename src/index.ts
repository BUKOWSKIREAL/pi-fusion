import { existsSync } from 'node:fs';
import { Type } from 'typebox';
import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { FusionController } from './controller.ts';
import { createSidekick } from './sidekick.ts';
import { EDIT_REMINDER, FIRST_MESSAGE_REMINDER, GROUNDING_NOTE, LEAD_PROMPT, TOOL_DESCRIPTION } from './prompts.ts';
import { fusionLines } from './display.ts';
import { routeWithJev } from './router.ts';
import { freshState, parseModel, restoreState, type RunRecord, type FusionState } from './state.ts';
import { preferencesPath, readPreferences, writePreferences } from './preferences.ts';

const STATE_TYPE = 'pi-local-fusion/state';
const TOOL_NAMES = ['sidekick', 'read_sidekick', 'stop_sidekick'];
const textContent = (text: string) => [{ type: 'text' as const, text }];
const runText = (run?: RunRecord) => run ? `Sidekick ${run.status} (${run.id}).\n${run.report}` : 'No sidekick handoff yet.';

export default function fusion(pi: ExtensionAPI) {
  let state = freshState();
  let controller: FusionController | undefined;
  let context: ExtensionContext | undefined;
  let active = true;
  let leadActive = false;
  let redraw: (() => void) | undefined;
  function save() {
    if (!active) return;
    pi.appendEntry(STATE_TYPE, structuredClone(state));
    renderStatus();
  }
  function persistPreferences(ctx: ExtensionContext, onlyIfMissing = false) {
    try { writePreferences(state, undefined, onlyIfMissing); }
    catch { ctx.ui.notify(`Fusion settings updated for this session, but defaults could not be saved to ${preferencesPath()}.`, 'warning'); }
  }
  function renderStatus() {
    if (!context?.hasUI) return;
    context.ui.setStatus('fusion', state.enabled
      ? `Fusion · ${controller?.running ? controller.progress : state.last?.status ?? 'ready'}` : undefined);
    if (context.mode !== 'tui') return;
    if (!state.enabled) {
      context.ui.setWidget('fusion-models', undefined);
      redraw = undefined;
      return;
    }
    if (!redraw) context.ui.setWidget('fusion-models', (tui, theme) => {
      redraw = () => tui.requestRender();
      return {
        invalidate() {},
        render: (width) => fusionLines({
          lead: context?.model ? `${context.model.provider}/${context.model.id}` : 'lead',
          leadThinking: context?.thinkingLevel ?? pi.getThinkingLevel(),
          sidekick: controller?.modelInfo?.model ?? state.assignment?.model ?? state.config.model ?? 'choose sidekick',
          sidekickThinking: controller?.modelInfo?.thinking ?? state.config.thinking,
          leadActive, sidekickActive: controller?.modelActive ?? false,
          routing: state.config.routing === 'jev' && state.routeAdvice
            ? `Jev → ${state.routeAdvice.recommendation} · ${state.routeAdvice.latencyMs}ms · ${state.routeAdvice.model ?? 'fallback'}` : undefined,
        }, width, theme),
      };
    }, { placement: 'belowEditor' });
    redraw?.();
  }
  function syncTools() {
    const others = pi.getActiveTools().filter(name => !TOOL_NAMES.includes(name));
    pi.setActiveTools(state.enabled ? [...others, ...TOOL_NAMES] : others);
  }
  async function start(ctx: ExtensionContext) {
    context = ctx;
    active = true;
    leadActive = false;
    redraw = undefined;
    const saved = ctx.sessionManager.getBranch().findLast(entry => entry.type === 'custom' && entry.customType === STATE_TYPE);
    if (saved?.type === 'custom') {
      state = restoreState(saved.data);
      if (state.config.model && !existsSync(preferencesPath())) persistPreferences(ctx, true);
    } else {
      state = freshState();
      try {
        const preferences = readPreferences();
        if (preferences) { state.enabled = preferences.enabled; state.config = preferences.config; }
      } catch { ctx.ui.notify(`Could not read Fusion defaults from ${preferencesPath()}; using initial defaults.`, 'warning'); }
    }
    if (!state.config.model && process.env.PI_FUSION_MODEL) state.config.model = parseModel(process.env.PI_FUSION_MODEL);
    const ownState = state;
    controller = new FusionController(state, {
      create: () => createSidekick({ ctx, config: { ...ownState.config, model: ownState.assignment?.model ?? ownState.config.model }, checkpoint: ownState.checkpoint, settings: pi.getSettings() }),
      changed: () => { if (state === ownState) save(); },
      completed: (run) => {
        if (!active || state !== ownState || !state.enabled) return;
        // Tool promptGuidelines stay active during these wakes (before_agent_start may not fire).
        pi.sendMessage({
          customType: 'pi-local-fusion/completed', display: true,
          content: `Sidekick handoff ${run.id} ${run.status}. Call read_sidekick to retrieve the report and usage, then review the diff and evidence before continuing.`,
          details: { runId: run.id, status: run.status },
        }, { triggerTurn: true, deliverAs: 'followUp' });
      },
    });
    syncTools();
    renderStatus();
    // Snapshot the inherited or restored preferences onto this branch so a later resume stays stable.
    save();
  }
  function requireController(ctx: ExtensionContext) {
    context = ctx;
    if (!controller || !active) throw new Error('Fusion session is not initialized. Reload Pi.');
    return controller;
  }
  pi.on('session_start', async (_event, ctx) => { await start(ctx); });
  pi.on('session_shutdown', async () => {
    await controller?.close();
    active = false;
    context?.ui.setStatus('fusion', undefined);
    context?.ui.setWidget('fusion-models', undefined);
    redraw = undefined;
  });
  pi.on('session_before_tree', async () => { await controller?.close(); });
  pi.on('session_tree', async (_event, ctx) => { await start(ctx); });

  pi.on('turn_start', (_event, ctx) => { context = ctx; leadActive = true; renderStatus(); });
  pi.on('message_end', (event, ctx) => {
    if (event.message.role === 'assistant') { context = ctx; leadActive = false; renderStatus(); }
  });
  pi.on('agent_end', () => { leadActive = false; renderStatus(); });
  pi.on('model_select', (_event, ctx) => { context = ctx; renderStatus(); });
  pi.on('thinking_level_select', (_event, ctx) => { context = ctx; renderStatus(); });
  pi.on('before_agent_start', async (event, ctx) => {
    context = ctx;
    if (!state.enabled) return;
    const owner = state;
    const notes: string[] = [];
    if (state.config.reminders && !state.messageReminded) {
      notes.push(FIRST_MESSAGE_REMINDER, GROUNDING_NOTE);
      state.messageReminded = true;
    }
    if (controller?.running) notes.push('A sidekick handoff is running. Evaluate this user message before waiting again. Relay relevant changes through sidekick; the sidekick cannot see user messages automatically.');
    if (state.config.routing === 'jev') {
      const advice = await routeWithJev(event.prompt, { signal: ctx.signal });
      if (!active || state !== owner) return;
      state.routeAdvice = advice;
      if (advice.usage) {
        const usage = state.routingUsage ?? { requests: 0, input: 0, output: 0 };
        state.routingUsage = { requests: usage.requests + 1, input: usage.input + advice.usage.input_tokens, output: usage.output + advice.usage.output_tokens };
      }
      notes.push(`Jev routing advice: ${advice.recommendation}. Choice=${advice.choice ?? 'unavailable'}, confidence=${advice.confidence ?? 'n/a'}. ${advice.reason} This is not permission or proof; you retain context, decisions and review. If appropriate, supply the sidekick a complete brief.`);
    }
    save();
    if (notes.length) return { message: { customType: 'pi-local-fusion/guidance', display: false, content: notes.join('\n\n') } };
  });
  pi.on('tool_result', (event) => {
    if (!state.enabled || !state.config.reminders || state.editReminded || event.isError
      || !['edit', 'write', 'apply_patch'].includes(event.toolName)) return;
    state.editReminded = true;
    save();
    return { content: [...event.content, ...textContent(EDIT_REMINDER)], structuredContent: event.structuredContent };
  });

  pi.registerTool({
    name: 'sidekick', label: 'Sidekick', defaultActive: false, exposure: 'model-only', executionMode: 'sequential',
    description: TOOL_DESCRIPTION + '\nPi: waits default to 60 seconds; on timeout work continues in background. Updates are applied at the next tool boundary.',
    promptSnippet: 'Delegate implementation and verification to one persistent sidekick.',
    promptGuidelines: [LEAD_PROMPT],
    parameters: Type.Object({ message: Type.String({ minLength: 1 }), block: Type.Optional(Type.Boolean({ default: true })) }),
    async execute(_id, args, signal, onUpdate, ctx) {
      if (signal?.aborted) throw new Error('Handoff cancelled before dispatch.');
      const c = requireController(ctx);
      const off = c.subscribe(progress => onUpdate?.({ content: textContent(progress), details: undefined }));
      try {
        const sent = await c.dispatch(args.message, args.block === false);
        if (signal?.aborted) { await c.stop('Lead interrupted handoff startup.'); throw new Error('Handoff cancelled.'); }
        if (args.block === false) return {
          content: textContent(`${sent.steered ? 'Update queued for the running sidekick' : 'Handoff started'} (${sent.run.id}). Completion will be announced. Use read_sidekick to wait or retrieve the report.`),
          details: { runId: sent.run.id, steered: sent.steered },
        };
        const result = await c.wait(60_000, signal);
        if (result.interrupted) throw new Error('Blocking handoff interrupted; sidekick cancellation requested, context retained.');
        const body = result.timedOut
          ? `Sidekick is still running (${result.run?.id}). Wait timed out, not the task. Continue independent work or use read_sidekick({block:true}).`
          : runText(result.run);
        return { content: textContent(body), details: result, usage: result.timedOut ? undefined : c.claimUsage(),
          isError: !result.timedOut && result.run?.status !== 'completed' };
      } finally { off(); }
    },
  });
  pi.registerTool({
    name: 'read_sidekick', label: 'Read sidekick', defaultActive: false, exposure: 'model-only', executionMode: 'sequential',
    description: 'Read the latest sidekick report or block for completion. Wait timeouts do not cancel work. Usage is reported only once. Do not poll in a loop.',
    parameters: Type.Object({ block: Type.Optional(Type.Boolean({ default: true })),
      timeoutSeconds: Type.Optional(Type.Number({ minimum: 1, maximum: 300, default: 60 })) }),
    async execute(_id, args, signal, _onUpdate, ctx) {
      const c = requireController(ctx);
      const result = args.block === false ? { run: state.last && structuredClone(state.last) } : await c.wait((args.timeoutSeconds ?? 60) * 1000, signal);
      if (result.interrupted) throw new Error('Wait interrupted; sidekick cancellation requested.');
      const running = result.run?.status === 'running';
      return { content: textContent(running ? `Sidekick is running. ${c.progress}` : runText(result.run)),
        details: { ...result, sessionFile: state.checkpoint?.file },
        usage: running ? undefined : c.claimUsage(),
        isError: !!result.run && !running && result.run.status !== 'completed' };
    },
  });
  pi.registerTool({
    name: 'stop_sidekick', label: 'Stop sidekick', defaultActive: false, exposure: 'model-only', executionMode: 'sequential',
    description: 'Cancel the current sidekick run and keep its context and existing file changes for the next handoff.',
    parameters: Type.Object({ reason: Type.Optional(Type.String()) }),
    async execute(_id, args, _signal, _onUpdate, ctx) {
      const c = requireController(ctx);
      await c.stop(args.reason || 'Lead stopped the handoff.');
      return { content: textContent(runText(state.last)), details: { run: state.last }, usage: c.claimUsage() };
    },
  });

  function overview(ctx: ExtensionContext) {
    return [
      `Fusion ${state.enabled ? 'on' : 'off'}`,
      `Lead: ${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : '(current Pi model)'}`,
      `Sidekick: ${controller?.modelInfo?.model ?? state.assignment?.model ?? state.config.model ?? '(not selected)'}`,
      state.enabled ? 'Send tasks as usual. Fusion is ready.' : 'Open /fusion to turn on or choose a sidekick.',
    ].join('\n');
  }
  async function chooseModel(ctx: ExtensionCommandContext) {
    if (!ctx.hasUI) {
      ctx.ui.notify('Choose a sidekick with /fusion model provider/model-id. Use an available model from Pi.', 'info');
      return;
    }
    if (requireController(ctx).running) {
      ctx.ui.notify('The sidekick is busy. Open /fusion and stop the current work before changing models.', 'warning');
      return;
    }
    const models = ctx.modelRegistry.getAvailable().filter(m => m.api !== 'pi-virtual');
    if (!models.length) {
      ctx.ui.notify('No sidekick models are available. Set up a provider with /login in Pi, then open /fusion again.', 'warning');
      return;
    }
    const current = state.assignment?.model ?? state.config.model;
    const references = models.map(m => `${m.provider}/${m.id}`);
    references.sort((a, b) => Number(b === current) - Number(a === current) || a.localeCompare(b));
    const picked = await ctx.ui.select('Choose sidekick model — selecting turns Fusion on', references);
    if (picked) await configureModel(picked, ctx);
  }
  async function configureModel(value: string, ctx: ExtensionContext) {
    const modelRef = parseModel(value);
    const slash = modelRef.indexOf('/');
    const model = ctx.modelRegistry.find(modelRef.slice(0, slash), modelRef.slice(slash + 1));
    if (!model || model.api === 'pi-virtual' || !ctx.modelRegistry.hasConfiguredAuth(model)) throw new Error(`Model unavailable or not authenticated: ${modelRef}`);
    // Replacing a configured default re-points the live idle child and keeps its context.
    await requireController(ctx).assignModel(modelRef);
    state.config.model = modelRef;
    state.enabled = true;
    state.assignment = undefined;
    save(); syncTools();
    persistPreferences(ctx);
    ctx.ui.notify(overview(ctx), 'info');
  }
  function status() {
    return [
      `Fusion ${state.enabled ? 'on' : 'off'}`,
      `Sidekick: ${state.config.model ?? '(not selected)'}, thinking: ${state.config.thinking}, tools: ${state.config.tools}`,
      `Limit: ${state.config.timeoutMs / 60_000} minutes / ${state.config.maxTurns} turns per handoff`,
      `State: ${controller?.running ? controller.progress : state.last?.status ?? 'ready'}`,
      `Routing: ${state.config.routing}${state.routeAdvice ? ` → ${state.routeAdvice.recommendation} (${state.routeAdvice.model ?? 'fallback'}, ${state.routeAdvice.latencyMs}ms)` : ''}`,
      `Defaults: ${preferencesPath()}`,
      `Assigned sidekick: ${controller?.modelInfo?.model ?? state.assignment?.model ?? state.config.model ?? '(not selected)'}`,
      state.routingUsage ? `Jev: ${state.routingUsage.requests} recorded requests, ${state.routingUsage.input} input / ${state.routingUsage.output} output tokens (separate from /cost)` : '',
      `Session: ${state.checkpoint?.file ?? '(created on first handoff)'}`,
      state.last ? `Last handoff: ${state.last.usage.totalTokens} tokens, $${state.last.usage.cost.total.toFixed(4)} (reported API usage)` : '',
    ].filter(Boolean).join('\n');
  }
  const help = [
    '/fusion — open settings; choose a sidekick once, then send tasks normally',
    '/fusion-model — choose or change the sidekick model',
    '/fusion on · /fusion off — enable or disable',
    '/fusion status — show details',
    '/fusion stop — stop current work, keeping context',
    'Advanced (optional):',
    '/fusion model provider/model-id — save the default sidekick model',
    '/fusion assign provider/model-id — override the model on this branch',
    '/fusion compact — compact the idle sidekick',
    '/fusion reset — start fresh; existing files are kept',
    '/fusion thinking level · /fusion tools coding|readonly',
    '/fusion timeout minutes · /fusion turns count',
    '/fusion reminders on|off · /fusion routing jev|off',
  ].join('\n');
  async function command(args: string, ctx: ExtensionCommandContext) {
    try {
      const c = requireController(ctx);
      if (!args.trim()) {
        if (!ctx.hasUI) { ctx.ui.notify(`${overview(ctx)}\nUse /fusion help for commands.`, 'info'); return; }
        if (!state.config.model) { await chooseModel(ctx); return; }
        const modelChoice = `Sidekick model: ${c.modelInfo?.model ?? state.assignment?.model ?? state.config.model}`;
        const toggleChoice = state.enabled ? 'Turn off' : 'Turn on';
        const choices = [modelChoice, toggleChoice, 'View details'];
        if (c.running) choices.push('Stop current work');
        const choice = await ctx.ui.select(`Fusion · ${state.enabled ? 'On' : 'Off'}`, choices);
        if (!choice) return;
        if (choice === modelChoice) { await chooseModel(ctx); return; }
        args = choice === toggleChoice ? (state.enabled ? 'off' : 'on') : choice === 'Stop current work' ? 'stop' : 'status';
      }
      const [action, ...rest] = args.trim().split(/\s+/);
      const value = rest.join(' ');
      if (action === 'help') { ctx.ui.notify(help, 'info'); return; }
      if (action === 'model') { if (value) await configureModel(value, ctx); else await chooseModel(ctx); return; }
      if (action === 'assign') {
        // Branch-local physical model for this session's sidekick; defaults are untouched.
        const modelRef = parseModel(value);
        const slash = modelRef.indexOf('/');
        const model = ctx.modelRegistry.find(modelRef.slice(0, slash), modelRef.slice(slash + 1));
        if (!model || model.api === 'pi-virtual' || !ctx.modelRegistry.hasConfiguredAuth(model)) throw new Error(`Model unavailable or not authenticated: ${modelRef}`);
        if (!state.config.model) throw new Error('Choose a sidekick model with /fusion model provider/model first.');
        if (!state.enabled) throw new Error('Fusion is off. Enable it with /fusion on.');
        await c.assignModel(modelRef);
        ctx.ui.notify(status(), 'info');
        return;
      }
      if (action === 'compact') { await c.compact(); ctx.ui.notify(status(), 'info'); return; }
      if (action === 'status') { ctx.ui.notify(status(), 'info'); return; }
      if (action === 'stop') { await c.stop('Stopped by user.'); ctx.ui.notify(status(), 'info'); return; }
      if (action === 'off') { await c.stop('Fusion disabled by user.'); state.enabled = false; }
      else if (action === 'on') {
        if (!state.config.model) { await chooseModel(ctx); return; }
        state.enabled = true;
      } else if (action === 'reset') {
        await c.stop('Sidekick reset by user.');
        await c.release();
        state.checkpoint = undefined;
        state.last = undefined;
        state.assignment = undefined;
        state.editReminded = false;
        state.messageReminded = false;
        // pendingUsage remains owed to the lead's next tool result.
      } else if (['thinking', 'tools', 'timeout', 'turns', 'reminders', 'routing'].includes(action!)) {
        const config = { ...state.config };
        if (action === 'thinking') {
          if (!['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(value)) throw new Error('Unknown thinking level.');
          config.thinking = value as FusionState['config']['thinking'];
        } else if (action === 'tools') {
          if (value !== 'coding' && value !== 'readonly') throw new Error('Tools must be coding or readonly.');
          config.tools = value;
        } else if (action === 'routing') {
          if (value !== 'jev' && value !== 'off') throw new Error('Routing must be jev or off.');
          if (value === 'jev' && !process.env.TYPESAFE_API_KEY) throw new Error('Set TYPESAFE_API_KEY in the environment first.');
          config.routing = value;
        } else if (action === 'reminders') {
          if (value !== 'on' && value !== 'off') throw new Error('Reminders must be on or off.');
          config.reminders = value === 'on';
        } else {
          const n = Number(value);
          if (!Number.isSafeInteger(n) || n < 1 || n > (action === 'timeout' ? 240 : 1000)) throw new Error('Invalid limit. timeout: 1–240 minutes; turns: 1–1000.');
          if (action === 'timeout') config.timeoutMs = n * 60_000; else config.maxTurns = n;
        }
        await c.release();
        state.config = config;
      } else { ctx.ui.notify('Unknown Fusion command. Open /fusion for settings, or /fusion help for commands.', 'warning'); return; }
      save(); syncTools(); renderStatus();
      if (action === 'on' || action === 'off' || ['thinking', 'tools', 'timeout', 'turns', 'reminders', 'routing'].includes(action!)) persistPreferences(ctx);
      ctx.ui.notify(action === 'on' || action === 'off' ? overview(ctx) : status(), 'info');
    } catch (error) { ctx.ui.notify(String(error), 'error'); }
  }
  pi.registerCommand('fusion', { description: 'Open Fusion settings (choose a sidekick and turn on/off)', handler: command });
  pi.registerCommand('fusion-model', { description: 'Choose or change the sidekick model',
    handler: async (args, ctx) => command(args.trim() ? `model ${args.trim()}` : 'model', ctx) });
}
