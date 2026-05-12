// Portions derived from Hermes Agent (MIT) - NousResearch
// https://github.com/NousResearch/hermes-agent
//
// Shared types for the post-turn skill-learning review (Module 4.3).
// Consumed by skill-review-tool.ts (per-action result) and
// learning-review-trigger.ts (cooldown decisions via ReviewResult.skip*).

/**
 * Outcome of a single skill_manage tool call inside a review.
 * - "created" / "updated" / "deleted" — the action succeeded
 * - "skipped" — the action was rejected before reaching the filesystem
 *   (validation failure, duplicate in same review, content cap exceeded,
 *   unsupported action, etc.). `reason` carries the reject reason for logs.
 */
export type ReviewActionResult = "created" | "updated" | "deleted" | "skipped";

export type ReviewActionLog = {
  action: string;
  name: string;
  result: ReviewActionResult;
  reason?: string;
};

/**
 * Aggregate result of one review pass. Returned by runSkillReview to the
 * trigger module, which uses skillsCreated/Updated/Deleted + textOutput to
 * decide whether to advance the cooldown counter.
 */
export type ReviewResult = {
  skillsCreated: number;
  skillsUpdated: number;
  skillsDeleted: number;
  /** Tool calls rejected by guardrails (cap, dedup, validation). */
  skipped: number;
  /** Final assistant text (e.g. "Nothing to save."). Logged, not returned to user. */
  textOutput: string;
  /** Anthropic/OpenAI-style input token count, when available. */
  tokensIn?: number;
  /** Anthropic/OpenAI-style output token count, when available. */
  tokensOut?: number;
  /** Per-action log for trace-level debugging. */
  actionsLog?: ReviewActionLog[];
};

export const EMPTY_REVIEW_RESULT: ReviewResult = {
  skillsCreated: 0,
  skillsUpdated: 0,
  skillsDeleted: 0,
  skipped: 0,
  textOutput: "",
};

/**
 * True iff the review produced no skill changes. Used by the trigger module
 * to advance the cooldown streak (G4 — three empty reviews → 10-turn cooldown).
 */
export function isEmptyReview(result: ReviewResult): boolean {
  return result.skillsCreated === 0 && result.skillsUpdated === 0 && result.skillsDeleted === 0;
}
