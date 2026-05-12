// Portions derived from Hermes Agent (MIT) - NousResearch
// https://github.com/NousResearch/hermes-agent
//
// Persists turn-completion messages into the per-workspace FTS5 store
// so they can be recalled by the memory_search tool.
//
// Called from attempt.ts after finalizeAttemptContextEngineTurn — strictly
// best-effort: a write failure logs a warning but never fails the turn.

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getOrOpenFtsStore } from "../../memory/fts-store-cache.js";
import { resolveAgentWorkspaceDir } from "../agent-scope.js";
import { log } from "./logger.js";

export type PersistTurnMessagesParams = {
  sessionId: string;
  agentId: string;
  config: OpenClawConfig;
  messagesSnapshot: AgentMessage[];
  /**
   * Number of messages already present at the start of this turn.
   * Only messages with index >= this value will be inserted (idempotency).
   */
  prePromptMessageCount: number;
  /** Model id from this turn, if known. Used for session metadata on first insert. */
  model?: string;
};

type TextRole = "user" | "assistant" | "tool";

const KEEP_ROLES: ReadonlySet<TextRole> = new Set(["user", "assistant"]);

function extractText(content: AgentMessage["content"]): string {
  if (typeof content === "string") {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === "string") {
      parts.push(block);
      continue;
    }
    if (!block || typeof block !== "object") {
      continue;
    }
    const text = (block as { text?: unknown }).text;
    if (typeof text === "string" && text.length > 0) {
      parts.push(text);
    }
  }
  return parts.join("\n").trim();
}

function toInsertableRole(role: AgentMessage["role"]): TextRole | null {
  if (typeof role !== "string") return null;
  if (!KEEP_ROLES.has(role as TextRole)) return null;
  return role as TextRole;
}

/**
 * Insert any new messages from this turn into the FTS store.
 * Returns the count of newly-inserted messages.
 *
 * No-op when messagesSnapshot is empty or prePromptMessageCount is at the end.
 * Errors are logged but never thrown — FTS persistence is non-critical.
 */
export function persistTurnMessagesToFts(params: PersistTurnMessagesParams): number {
  try {
    const newMessages = params.messagesSnapshot.slice(Math.max(0, params.prePromptMessageCount));
    if (newMessages.length === 0) {
      return 0;
    }

    const workspaceDir = resolveAgentWorkspaceDir(params.config, params.agentId);
    const store = getOrOpenFtsStore(workspaceDir);
    store.ensureSession(params.sessionId, params.model);

    let inserted = 0;
    for (const msg of newMessages) {
      const role = toInsertableRole(msg.role);
      if (!role) continue;
      const content = extractText(msg.content);
      if (!content) continue;

      store.insertMessage({
        sessionId: params.sessionId,
        role,
        content,
      });
      inserted += 1;
    }
    return inserted;
  } catch (err) {
    log.warn(`FTS turn persistence failed for session ${params.sessionId}: ${String(err)}`);
    return 0;
  }
}
