// Portions derived from Hermes Agent (MIT) - NousResearch
// https://github.com/NousResearch/hermes-agent
//
// Provenance tracking for skill writes: distinguishes agent-created skills
// (from background review) from user-directed skills (foreground sessions).
// Uses AsyncLocalStorage so the origin flows through async call chains
// without explicit parameter threading.

import { AsyncLocalStorage } from "node:async_hooks";

export type WriteOrigin = "foreground" | "background_review";

const _writeOrigin = new AsyncLocalStorage<WriteOrigin>();

/**
 * Run fn inside a background_review context.
 * Skills created inside fn will be marked as agent-created and are eligible
 * for automatic curation. Skills created outside (foreground) are user-owned
 * and must never be auto-deleted.
 */
export function runAsBackgroundReview<T>(fn: () => Promise<T>): Promise<T> {
  return _writeOrigin.run("background_review", fn);
}

export function getWriteOrigin(): WriteOrigin {
  return _writeOrigin.getStore() ?? "foreground";
}

export function isBackgroundReview(): boolean {
  return getWriteOrigin() === "background_review";
}
