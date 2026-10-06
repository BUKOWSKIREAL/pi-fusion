import type { Usage } from '@earendil-works/pi-ai';
import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import type { RouteAdvice } from './router.ts';

export interface FusionConfig {
  model?: string;
  thinking: ThinkingLevel;
  tools: 'coding' | 'readonly';
  timeoutMs: number;
  maxTurns: number;
  reminders: boolean;
  routing: 'off' | 'jev';
}
export const DEFAULT_CONFIG: FusionConfig = {
  thinking: 'medium', tools: 'coding', timeoutMs: 900_000, maxTurns: 80, reminders: true, routing: 'off',
};
export interface Checkpoint { file: string; leaf: string | null }
export type RunStatus = 'running' | 'completed' | 'failed' | 'cancelled';
export interface RunRecord {
  id: string;
  status: RunStatus;
  startedAt: number;
  endedAt?: number;
  report: string;
  usage: Usage;
  claimed: boolean;
}
export interface FusionState {
  version: 1;
  enabled: boolean;
  config: FusionConfig;
  checkpoint?: Checkpoint;
  last?: RunRecord;
  pendingUsage: Usage;
  editReminded: boolean;
  messageReminded?: boolean;
  routeAdvice?: RouteAdvice;
  routingUsage?: { requests: number; input: number; output: number };
}
export function freshState(): FusionState {
  return { version: 1, enabled: false, config: { ...DEFAULT_CONFIG }, pendingUsage: zeroUsage(), editReminded: false };
}
export function zeroUsage(): Usage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}
export function addUsage(a: Usage, b: Usage): Usage {
  return {
    input: a.input + b.input, output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite,
    totalTokens: a.totalTokens + b.totalTokens,
    ...(a.reasoning !== undefined || b.reasoning !== undefined ? { reasoning: (a.reasoning ?? 0) + (b.reasoning ?? 0) } : {}),
    cost: { input: a.cost.input + b.cost.input, output: a.cost.output + b.cost.output,
      cacheRead: a.cost.cacheRead + b.cost.cacheRead, cacheWrite: a.cost.cacheWrite + b.cost.cacheWrite,
      total: a.cost.total + b.cost.total },
  };
}
export function parseModel(value: string): string {
  const at = value.indexOf('/');
  if (at < 1 || at === value.length - 1 || /\s/.test(value)) {
    throw new Error('Model must be an exact provider/model-id. Set thinking separately with /fusion thinking.');
  }
  return value;
}
export function restoreState(data: unknown): FusionState {
  // Session entries are local data, but reject malformed or older layouts explicitly.
  if (!data || typeof data !== 'object' || (data as FusionState).version !== 1) return freshState();
  const s = structuredClone(data as FusionState);
  if (!s.config) throw new Error('Invalid saved Fusion configuration.');
  s.config.routing ??= 'off';
  s.pendingUsage ??= zeroUsage();
  if (typeof s.enabled !== 'boolean' || !['coding', 'readonly'].includes(s.config.tools)
    || !['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(s.config.thinking)
    || !Number.isSafeInteger(s.config.maxTurns) || s.config.maxTurns < 1
    || !Number.isSafeInteger(s.config.timeoutMs) || s.config.timeoutMs < 1000
    || typeof s.config.reminders !== 'boolean' || !['off', 'jev'].includes(s.config.routing)) throw new Error('Invalid saved Fusion configuration.');
  if (s.config.model) parseModel(s.config.model);
  if (s.last?.status === 'running') {
    s.pendingUsage = addUsage(s.pendingUsage, s.last.usage);
    s.last.status = 'cancelled';
    s.last.endedAt = Date.now();
    s.last.report = 'Previous handoff was interrupted by process/session shutdown. Context was saved; send a new brief to continue. Inspect existing changes before repeating work.';
  }
  return s;
}
