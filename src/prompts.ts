import { readFileSync } from 'node:fs';

// These files are byte-for-byte UTF-8 spans from the user's local Devin executable.
// Substitutions and Pi-specific capabilities are kept here, outside the originals.
const raw = (name: string) => readFileSync(new URL(`../resources/devin-original/${name}`, import.meta.url), 'utf8');
const leadVariants = raw('lead-variants.txt');
const sideVariants = raw('sidekick-variants.txt');
function between(text: string, start: string, end: string): string {
  const a = text.indexOf(start);
  const b = text.indexOf(end, a + start.length);
  if (a < 0 || b < 0) throw new Error(`Missing original prompt fragment: ${start}`);
  return text.slice(a, b);
}
export function renderTemplate(template: string, values: Record<string, string>): string {
  // Some selected original fragments themselves refer to tool-name placeholders.
  for (let i = 0; i < 4; i++) {
    template = template.replace(/\{([A-Z_]+)\}/g, (match, key: string) => {
      if (!(key in values)) throw new Error(`Unresolved original prompt placeholder: ${match}`);
      return values[key]!;
    });
    if (!/\{[A-Z_]+\}/.test(template)) return template;
  }
  throw new Error('Recursive original prompt substitutions.');
}
const substitutions: Record<string, string> = {
  SIDEKICK_TOOL: 'sidekick', READ_TOOL: 'read_sidekick', LEAD_IDENTITY: 'Pi lead',
  HANDS_ON_EXPLORATION: '', DELEGATE_SCOPE: 'implementation and verification', DELEGATE_EXPLORATION: '',
  LEAD_EXPLORATION: between(leadVariants, 'Investigations (e.g.', 'Investigation that requires your judgment'),
  LEAD_AUTHORITY: 'Talking to the user, pull request creation and updates, and code-review responses.',
  BROWSER_IMPLEMENTATION: between(leadVariants, 'trivially small (', 'trivially small (you can make the edit AND confirm it in 1-2 of your own turns total, with nothing left to test afterwards, e.g. a stray import); correctness-critical (below);'),
  COMPLEX_BROWSER_BULLET: between(leadVariants, '\n  - **Complex interactive browser work.**', '{COMPLEX_BROWSER_BULLET}'),
  BROWSER_BULLET: '\n- If what lands is a visual artifact, open it rendered before you hand it over.',
  REVIEW_BULLET: '',
  PROMISED_ACTIONS: between(leadVariants, 'Track the lead-only actions you have promised the user —', 'Track the lead-only actions you have promised the user (messages,'),
  PARALLEL_WORK: 'reviewing an earlier diff, reading code you need for the next brief',
  STEERING_SURFACE: between(leadVariants, 'call `{SIDEKICK_TOOL}` again', '\n- Review comments:'),
  UNSETTLED_ASK: between(leadVariants, '**Never hand off implementation of an unsettled ask.**', '\n- **Specify the code,'),
  FILE_POINTERS_BULLET: between(leadVariants, '\n- **Specify the code,', '{FILE_POINTERS_BULLET}'),
  BLOCKING_DISPATCH_BULLET: between(leadVariants, '\n- **One blocking handoff', '{BLOCKING_DISPATCH_BULLET}'),
  EVIDENCE_BULLET: between(leadVariants, 'Review the evidence it reports back', "Review the sidekick's report;"),
  REVIEW_VERDICT_CLAUSE: 'read the full diff and give it a verdict',
};

export const PI_LEAD_ADAPTER = `\n\n## Pi runtime compatibility\nThe original Devin role text above describes this Pi lead/sidekick workflow; it does not imply Devin affiliation. User instructions and existing authorization take precedence. Be truthful about delegation and verification. Do not add permission questions for work already authorized.\nThere is exactly one persistent sidekick. Its tools are Pi built-ins; it has no browser, MCP, other extensions, skill catalogue or user-dialog tools. Shared files persist, but each bash call uses a separate shell; do not assume shell state or background jobs survive handoffs.\nsidekick and read_sidekick block for at most 60 seconds by default. A wait timeout leaves the job running and announces completion later; use read_sidekick to retrieve its evidence and usage once. stop_sidekick explicitly cancels work. Updates enter the same sidekick at the next tool boundary, not as a force-kill. Lead user messages are not automatically forwarded.\nLead owns commits, pushes, PRs and user communication. Review complete diffs and supplied evidence. The original anti-duplication guidance does not excuse omitting a required check or accepting suspicious evidence. When Jev routing advice is present it is a fallible suggestion, never authority or proof of task completion.`;
export const LEAD_PROMPT = renderTemplate(raw('lead.template.md'), substitutions) + PI_LEAD_ADAPTER;
export const SIDEKICK_PROMPT = renderTemplate(raw('sidekick.template.md'), {
  TASK_MANAGEMENT: between(sideVariants, 'Task management: for multi-step work, keep a concise plan', 'Task management: for multi-step work, use the todo_write'),
  VISUAL_VERIFICATION: raw('visual-verification.txt') + '\n',
  PERSISTENT_SHELLS: '',
  FILE_TOOL_PREFERENCE: between(sideVariants, 'Prefer the builtin search tools', 'Do your work through the exec tool'),
}) + `\n\n## Pi runtime compatibility\nYou are the sidekick in Pi; the original text's Devin name denotes the role, not product affiliation. Only the tools actually listed in this session are available. There is no browser, exec tool, todo_write, skill catalogue, MCP or other agent tool. Use read/edit/write/grep/find/ls/bash as provided; if a required capability is missing, report it to the lead. Every bash invocation is a separate shell. Do not rely on persistent shell state or start untracked background processes. Retain context and files across handoffs, follow applicable repository instructions, and respect already established user authorization. Do not commit, push, manage PRs or contact the user.`;
export const EDIT_REMINDER = raw('first-edit-1.txt').trim();
export const FIRST_MESSAGE_REMINDER = renderTemplate(raw('first-message-1.template.md'), substitutions);
export const GROUNDING_NOTE = raw('grounding-note.txt');
export const REPORT_FIRST_GUIDANCE = raw('report-first.txt');
export const TOOL_DESCRIPTION = raw('tool-description-prefix.txt') + 'read_sidekick' + raw('tool-description-suffix.txt');
export const FIRST_HANDOFF = raw('first-handoff.txt');
export const leadUpdate = (message: string) => raw('lead-update-prefix.txt') + message + '\n' + raw('lead-update-suffix.txt');
