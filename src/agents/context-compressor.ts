// Portions derived from Hermes Agent (MIT) - NousResearch
// https://github.com/NousResearch/hermes-agent
//
// Facade over OpenClaw's existing compaction functions that adds an explicit
// percentage threshold trigger and a two-step algorithm:
//   Step 1 — prune oldest messages without LLM (fast, free)
//   Step 2 — LLM summarization if still over threshold (slow, API call)

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { estimateMessagesTokens, pruneHistoryForContextShare } from "./compaction.js";

export const DEFAULT_COMPRESSION_THRESHOLD_PERCENT = 80;

export type CompressResult =
  | { compressed: false }
  | { compressed: true; messages: AgentMessage[]; prunedTokens: number; summarized: boolean };

export type SummarizeFn = (messages: AgentMessage[]) => Promise<AgentMessage[]>;

export type CompressIfNeededParams = {
  messages: AgentMessage[];
  /** Total context window token budget. */
  contextWindow: number;
  /** Fire compression when token usage exceeds this percentage. Default: 80. */
  thresholdPercent?: number;
  /** Injectable LLM summarization step. Called only when pruning is not enough. */
  summarizeFn?: SummarizeFn;
};

function usagePercent(messages: AgentMessage[], contextWindow: number): number {
  if (contextWindow <= 0) return 0;
  return (estimateMessagesTokens(messages) / contextWindow) * 100;
}

/**
 * Auto-compress messages when token usage exceeds thresholdPercent.
 *
 * Two-step algorithm:
 *   1. Prune old messages to 50% of context (no LLM).
 *   2. If still above threshold, call summarizeFn (LLM).
 *
 * No-op when under threshold or when contextWindow <= 0.
 */
export async function compressIfNeeded(params: CompressIfNeededParams): Promise<CompressResult> {
  const threshold = params.thresholdPercent ?? DEFAULT_COMPRESSION_THRESHOLD_PERCENT;

  if (
    params.contextWindow <= 0 ||
    usagePercent(params.messages, params.contextWindow) < threshold
  ) {
    return { compressed: false };
  }

  // Step 1: prune old messages without LLM
  const { messages: pruned, droppedTokens } = pruneHistoryForContextShare({
    messages: params.messages,
    maxContextTokens: params.contextWindow,
  });

  if (usagePercent(pruned, params.contextWindow) < threshold) {
    return {
      compressed: true,
      messages: pruned,
      prunedTokens: droppedTokens,
      summarized: false,
    };
  }

  // Step 2: LLM summarization (optional — callers that don't provide summarizeFn get prune-only)
  if (!params.summarizeFn) {
    return {
      compressed: true,
      messages: pruned,
      prunedTokens: droppedTokens,
      summarized: false,
    };
  }

  const summarized = await params.summarizeFn(pruned);
  return {
    compressed: true,
    messages: summarized,
    prunedTokens: droppedTokens,
    summarized: true,
  };
}
