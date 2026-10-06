import { randomUUID } from 'node:crypto';
import { linkSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { DEFAULT_CONFIG, freshState, restoreState, type FusionConfig, type FusionState } from './state.ts';

export interface FusionPreferences { version: 1; enabled: boolean; config: FusionConfig }
export const preferencesPath = (agentDir = getAgentDir()) => resolve(agentDir, 'fusion', 'config.json');
export function parsePreferences(value: unknown): FusionPreferences {
  if (!value || typeof value !== 'object') throw new Error('Invalid Fusion defaults.');
  const p = value as FusionPreferences;
  if (p.version !== 1 || typeof p.enabled !== 'boolean' || !p.config || typeof p.config !== 'object' || Array.isArray(p.config)) throw new Error('Invalid Fusion defaults.');
  const c = { ...DEFAULT_CONFIG, ...p.config };
  if (c.model !== undefined && (typeof c.model !== 'string' || !c.model)) throw new Error('Invalid Fusion default model.');
  const restored = restoreState({ ...freshState(), enabled: p.enabled, config: c });
  if (c.timeoutMs < 60_000 || c.timeoutMs > 240 * 60_000 || c.maxTurns > 1000 || (p.enabled && !c.model)) throw new Error('Invalid Fusion default limits or enabled model.');
  const config: FusionConfig = {
    ...(restored.config.model === undefined ? {} : { model: restored.config.model }),
    thinking: restored.config.thinking, tools: restored.config.tools,
    timeoutMs: restored.config.timeoutMs, maxTurns: restored.config.maxTurns,
    reminders: restored.config.reminders, routing: restored.config.routing,
  };
  return { version: 1, enabled: p.enabled, config };
}
export function readPreferences(agentDir = getAgentDir()): FusionPreferences | undefined {
  let raw: string;
  try { raw = readFileSync(preferencesPath(agentDir), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  return parsePreferences(JSON.parse(raw));
}
export function writePreferences(state: Pick<FusionState, 'enabled' | 'config'>, agentDir = getAgentDir(), onlyIfMissing = false): void {
  const prefs = parsePreferences({ version: 1, enabled: state.enabled, config: state.config });
  const file = preferencesPath(agentDir);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(prefs, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    if (onlyIfMissing) {
      try { linkSync(temporary, file); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    } else renameSync(temporary, file);
  } finally { rmSync(temporary, { force: true }); }
}
