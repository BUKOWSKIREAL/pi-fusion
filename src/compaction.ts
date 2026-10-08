import type { StreamFn } from '@earendil-works/pi-agent-core';
import { getCurrentSystemMessage, type RetryPolicy } from '@earendil-works/pi-ai';
import {
  buildSessionProjection, compact, estimateTokens,
  type ExtensionAPI, type SessionEntry, type SessionManager,
} from '@earendil-works/pi-coding-agent';

interface PinnedHandoff { entryId: string; text: string }
interface FusionCompactionDetails {
  readFiles: string[];
  modifiedFiles: string[];
  fusion: { version: 1; baseSummary: string; handoffEntryIds: string[] };
}

// Project the selected branch with compaction entries made context-invisible.
// Keeping their IDs/parent links lets Pi apply omissions and replacements without
// reviving discarded branches or an explicitly removed instruction.
export function pinnedHandoffs(branch: SessionEntry[], firstKeptEntryId: string): PinnedHandoff[] {
  const cut = branch.findIndex(entry => entry.id === firstKeptEntryId);
  if (cut < 0) throw new Error('Fusion compaction boundary is missing from the active branch.');
  const prefix = new Set(branch.slice(0, cut).map(entry => entry.id));
  const history: SessionEntry[] = branch.map(entry => entry.type === 'compaction'
    ? { type: 'custom', id: entry.id, parentId: entry.parentId, timestamp: entry.timestamp,
      customType: 'pi-local-fusion/compaction-placeholder' }
    : entry);
  return buildSessionProjection(history).entries.flatMap(entry => {
    if (!prefix.has(entry.sourceEntry.id)) return [];
    return entry.messages.flatMap(message => {
      if (message.role !== 'user') return [];
      if (typeof message.content === 'string') return [{ entryId: entry.sourceEntry.id, text: message.content }];
      if (message.content.some(block => block.type !== 'text')) {
        throw new Error('Fusion cannot compact a handoff with non-text content without losing its original content.');
      }
      return [{ entryId: entry.sourceEntry.id,
        text: message.content.filter(block => block.type === 'text').map(block => block.text).join('\n') }];
    });
  });
}

function previousDetails(branch: SessionEntry[]): FusionCompactionDetails | undefined {
  const entry = branch.findLast(entry => entry.type === 'compaction');
  if (entry?.type !== 'compaction') return;
  const details = entry.details as Partial<FusionCompactionDetails> | undefined;
  if (details?.fusion?.version !== 1 || typeof details.fusion.baseSummary !== 'string'
    || !Array.isArray(details.readFiles) || !details.readFiles.every(p => typeof p === 'string')
    || !Array.isArray(details.modifiedFiles) || !details.modifiedFiles.every(p => typeof p === 'string')) return;
  return details as FusionCompactionDetails;
}

export function sidekickCompaction(manager: SessionManager, onFailure: (message: string) => void, retry: RetryPolicy) {
  return (pi: ExtensionAPI) => {
    pi.on('session_before_compact', async (event, ctx) => {
      try {
        if (!ctx.model) throw new Error('No sidekick model is assigned.');
        const pins = pinnedHandoffs(event.branchEntries, event.preparation.firstKeptEntryId);
        const pinnedText = pins.length === 0 ? '' : '\n\n## Original handoff messages (verbatim, chronological)\n\n'
          + pins.map(pin => `### Message ${pin.entryId}\n\n${pin.text}`).join('\n\n');
        const budget = ctx.model.contextWindow - event.preparation.settings.reserveTokens;
        if (budget <= 0 || estimateTokens({ role: 'user', content: pinnedText, timestamp: 0 }) >= budget) {
          throw new Error('Pinned handoff text exceeds the sidekick context budget. Choose a larger-context model or explicitly reset the sidekick.');
        }
        const prior = previousDetails(event.branchEntries);
        const preparation = structuredClone(event.preparation);
        if (prior) {
          // Do not recursively summarize the exact-copy appendix. Rebuild it from
          // raw branch messages on every compaction, including any context edits.
          preparation.previousSummary = prior.fusion.baseSummary;
          for (const path of prior.readFiles) preparation.fileOps.read.add(path);
          for (const path of prior.modifiedFiles) preparation.fileOps.edited.add(path);
        }
        const stream: StreamFn = async (model, context, options) => {
          const response = ctx.modelRegistry.streamSimple(model, context, options);
          // Summarization consumes the final result, so record usage before returning
          // its stream. This also propagates ledger-write failures to the caller.
          const message = await response.result();
          manager.appendUsage('fusion_compaction', message.provider, message.model, message.usage);
          return response;
        };
        const result = await compact(preparation, ctx.model, undefined, undefined,
          event.customInstructions, event.signal, ctx.thinkingLevel, stream, undefined, retry);
        event.signal.throwIfAborted();
        const summary = result.summary + pinnedText;
        const fileDetails = result.details as { readFiles: string[]; modifiedFiles: string[] };
        const details: FusionCompactionDetails = { ...fileDetails,
          fusion: { version: 1, baseSummary: result.summary, handoffEntryIds: pins.map(pin => pin.entryId) } };
        const leaf = event.branchEntries.at(-1);
        const candidate: SessionEntry = { type: 'compaction', id: 'fusion-compaction-budget-check',
          parentId: leaf?.id ?? null, timestamp: new Date().toISOString(), summary,
          firstKeptEntryId: result.firstKeptEntryId, tokensBefore: result.tokensBefore, details, fromHook: true,
          systemMessage: getCurrentSystemMessage(buildSessionProjection(event.branchEntries).messages) };
        const estimated = buildSessionProjection([...event.branchEntries, candidate]).messages
          .reduce((total, message) => total + estimateTokens(message), 0);
        if (estimated >= budget) {
          throw new Error('Compacted context with pinned handoffs exceeds the sidekick context budget. Choose a larger-context model or explicitly reset the sidekick.');
        }
        return { compaction: { ...result, summary, details, usage: undefined } };
      } catch (error) {
        // Pi otherwise falls back to ordinary compaction after a hook exception,
        // which could silently discard the original handoff text.
        onFailure(`Fusion compaction failed: ${error instanceof Error ? error.message : String(error)}`);
        return { cancel: true };
      }
    });
  };
}
