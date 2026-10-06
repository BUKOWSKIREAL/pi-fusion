import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import type { Theme } from '@earendil-works/pi-coding-agent';

export interface FusionDisplay {
  lead: string;
  leadThinking: string;
  sidekick: string;
  sidekickThinking: string;
  leadActive: boolean;
  sidekickActive: boolean;
  routing?: string;
}
export function fusionLines(state: FusionDisplay, width: number, theme: Pick<Theme, 'fg' | 'bold'>): string[] {
  const model = (name: string, thinking: string, active: boolean) => {
    const label = `${active ? '●' : '○'} ${name} · ${thinking}`;
    return active ? theme.bold(theme.fg('accent', label)) : theme.fg('dim', label);
  };
  const lead = model(state.lead, state.leadThinking, state.leadActive);
  const sidekick = model(state.sidekick, state.sidekickThinking, state.sidekickActive);
  const separator = theme.fg('dim', '  ⇄  ');
  const combined = lead + separator + sidekick;
  const lines = visibleWidth(combined) <= width ? [combined]
    : [truncateToWidth(lead, width), truncateToWidth(sidekick, width)];
  if (state.routing) lines.push(truncateToWidth(theme.fg('dim', state.routing), width));
  return lines;
}
