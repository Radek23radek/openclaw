// Portions derived from Hermes Agent (MIT) - NousResearch
// https://github.com/NousResearch/hermes-agent
//
// Decides whether to fire a post-turn learning review and translates the live
// AgentMessage[] turn snapshot into the LearningMessage[] shape that
// scheduleLearningReview() expects.
//
// Throttling is two-dimensional:
//   1. Interval — fire every N turns (learning.nudgeInterval, default 5).
//   2. Natural-break — fire whenever the LAST assistant message in the turn
//      stopped with "end_turn" AND had no tool_use, AND an EARLIER assistant
//      message in the same turn DID have tool_use. This captures "the model
//      did some work and then wrapped up" — a good moment to reflect — while
//      ignoring short clarification questions ("ok, what exactly?").
//
// When learning.enabled !== true this module is a complete no-op: the counter
// does NOT advance, no logs are emitted. Disabled = as if the loop didn't exist.

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  scheduleLearningReview,
  type LearningMessage,
  type LearningReviewFn,
} from "./learning-review.js";
import { log } from "./logger.js";
import { isEmptyReview, type ReviewResult } from "./skill-review-types.js";

const DEFAULT_NUDGE_INTERVAL = 5;

// G4 cooldown: after N consecutive empty reviews per session, skip the next
// M turns. Empty = isEmptyReview(result) per skill-review-types.ts.
const COOLDOWN_EMPTY_STREAK_THRESHOLD = 3;
const COOLDOWN_TURNS = 10;

const turnCounters = new Map<string, number>();

type CooldownState = {
  emptyStreak: number;
  skipUntilTurnCount: number;
};

const cooldownStates = new Map<string, CooldownState>();

export type ScheduleIfDueParams = {
  sessionKey: string;
  agentId: string;
  config: OpenClawConfig;
  messagesSnapshot: AgentMessage[];
  prePromptMessageCount: number;
  reviewFn: LearningReviewFn;
};

type TriggerReason = "interval" | "natural-break";

function isLearningEnabled(config: OpenClawConfig): boolean {
  return config.learning?.enabled === true;
}

function hasToolUseBlock(msg: AgentMessage): boolean {
  if (!("content" in msg) || !Array.isArray(msg.content)) return false;
  return msg.content.some((block) => {
    if (!block || typeof block !== "object") return false;
    return (block as { type?: unknown }).type === "tool_use";
  });
}

function lastAssistant(messages: AgentMessage[]): AgentMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]!.role === "assistant") return messages[i];
  }
  return undefined;
}

function isNaturalBreak(turnMessages: AgentMessage[]): boolean {
  const last = lastAssistant(turnMessages);
  if (!last) return false;
  const stopReason = (last as { stopReason?: unknown }).stopReason;
  if (stopReason !== "end_turn") return false;
  if (hasToolUseBlock(last)) return false;
  // Earlier in this turn there must have been actual work (tool_use).
  const earlierWork = turnMessages.some(
    (m) => m !== last && m.role === "assistant" && hasToolUseBlock(m),
  );
  return earlierWork;
}

function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === "string") {
      parts.push(block);
      continue;
    }
    if (!block || typeof block !== "object") continue;
    const text = (block as { text?: unknown }).text;
    if (typeof text === "string" && text.length > 0) parts.push(text);
  }
  return parts.join("\n");
}

function toLearningMessages(messages: AgentMessage[]): LearningMessage[] {
  const result: LearningMessage[] = [];
  for (const msg of messages) {
    if (msg.role !== "user" && msg.role !== "assistant") continue;
    const text = extractTextContent(msg.content).trim();
    if (!text) continue;
    result.push({ role: msg.role, content: text });
  }
  return result;
}

/**
 * Increment the per-session turn counter and decide whether to fire a review.
 * No-op when learning.enabled !== true.
 *
 * Test-only: resetLearningReviewCountersForTest() clears the in-memory map.
 */
export function scheduleLearningReviewIfDue(params: ScheduleIfDueParams): void {
  if (!isLearningEnabled(params.config)) {
    return;
  }

  const turnCount = (turnCounters.get(params.sessionKey) ?? 0) + 1;
  turnCounters.set(params.sessionKey, turnCount);

  // G4 cooldown gate (B'): counter ticks above so passive expiry can land,
  // but we early-exit before computing interval/natural-break — cooldown is
  // a "soft disabled" window. Active reset (non-empty review clearing the
  // cooldown) happens via recordReviewResult below, not here.
  if (shouldSkipForCooldown(params.sessionKey, turnCount)) {
    log.info(
      `[learning-review] cooldown-active skip sessionKey=${params.sessionKey} agentId=${params.agentId} turnCount=${turnCount}`,
    );
    return;
  }

  const interval = params.config.learning?.nudgeInterval ?? DEFAULT_NUDGE_INTERVAL;
  const turnMessages = params.messagesSnapshot.slice(Math.max(0, params.prePromptMessageCount));

  let trigger: TriggerReason | null = null;
  if (interval > 0 && turnCount % interval === 0) {
    trigger = "interval";
  } else if (isNaturalBreak(turnMessages)) {
    trigger = "natural-break";
  }

  if (!trigger) {
    return;
  }

  log.info(
    `[learning-review] schedule sessionKey=${params.sessionKey} agentId=${params.agentId} trigger=${trigger} turnCount=${turnCount}`,
  );

  // Capture turnCount at fire time so cooldown bookkeeping uses the turn
  // the review STARTED at, not the turn it completed at (review latency
  // can be 1s–60s; tying cooldown duration to completion would introduce
  // jitter that has no semantic meaning).
  const turnCountAtFire = turnCount;

  scheduleLearningReview({
    sessionKey: params.sessionKey,
    messages: toLearningMessages(params.messagesSnapshot),
    config: params.config.learning,
    reviewFn: async (msgs) => {
      const startedAt = Date.now();
      try {
        const result = await params.reviewFn(msgs);
        log.info(
          `[learning-review] complete sessionKey=${params.sessionKey} durationMs=${Date.now() - startedAt}`,
        );
        if (result) {
          recordReviewResult(params.sessionKey, turnCountAtFire, result);
        }
      } catch (err) {
        log.warn(`[learning-review] failed sessionKey=${params.sessionKey} error=${String(err)}`);
        throw err;
      }
    },
  });
}

/**
 * Pure read: is this session currently in cooldown at the given turnCount?
 *
 * Returns true iff turnCount < skipUntilTurnCount. Passive expiry is
 * implicit — once turnCount reaches skipUntilTurnCount the check flips
 * back to false without any explicit reset call.
 */
export function shouldSkipForCooldown(sessionKey: string, turnCount: number): boolean {
  const state = cooldownStates.get(sessionKey);
  if (!state) return false;
  return turnCount < state.skipUntilTurnCount;
}

/**
 * Update cooldown state from a completed review result.
 *
 * G4 semantics:
 * - Empty review (isEmptyReview): increment emptyStreak. When the streak
 *   reaches COOLDOWN_EMPTY_STREAK_THRESHOLD (3), trip: set
 *   skipUntilTurnCount = turnCount + COOLDOWN_TURNS and reset emptyStreak
 *   to 0 so a fresh empty after passive expiry starts the next streak
 *   from 1, not 4.
 * - Non-empty review: clear both fields (active reset — first non-empty
 *   wins, whether mid-streak or even during an active cooldown window).
 *
 * Passive expiry needs no call here — turnCount naturally outpaces
 * skipUntilTurnCount and shouldSkipForCooldown returns false again.
 */
export function recordReviewResult(
  sessionKey: string,
  turnCount: number,
  result: ReviewResult,
): void {
  let state = cooldownStates.get(sessionKey);
  if (!state) {
    state = { emptyStreak: 0, skipUntilTurnCount: 0 };
    cooldownStates.set(sessionKey, state);
  }
  if (isEmptyReview(result)) {
    state.emptyStreak += 1;
    if (state.emptyStreak >= COOLDOWN_EMPTY_STREAK_THRESHOLD) {
      state.skipUntilTurnCount = turnCount + COOLDOWN_TURNS;
      state.emptyStreak = 0;
    }
  } else {
    state.emptyStreak = 0;
    state.skipUntilTurnCount = 0;
  }
}

export function resetLearningReviewCountersForTest(): void {
  turnCounters.clear();
  cooldownStates.clear();
}
