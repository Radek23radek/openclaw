// Portions derived from Hermes Agent (MIT) - NousResearch
// https://github.com/NousResearch/hermes-agent
//
// Persists turn-completion messages into the per-workspace FTS5 store
// so they can be recalled by the memory_search tool.
//
// Called from attempt.ts after finalizeAttemptContextEngineTurn — strictly
// best-effort: a write failure logs a warning but never fails the turn.
//
// Concurrency: runEmbeddedPiAgent runs inside enqueueSession() (run.ts), which
// is a strict FIFO lane per sessionKey. Two turns in the same session can never
// race here — prePromptMessageCount advances under that serial guarantee. Turns
// in *different* sessions run in parallel but write to different session_id
// rows; better-sqlite3 is synchronous within the process so the writes
// interleave but never tear.

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

const KEEP_ROLES: ReadonlySet<TextRole> = new Set(["user", "assistant", "tool"]);

// Head+tail cap for non-user content so a single huge tool output doesn't
// blow up the FTS table. User messages are kept 1:1 — they're typed by humans
// and never huge in practice.
const TRUNCATE_THRESHOLD_BYTES = 131_072; // 128 KiB
const HEAD_KEEP_BYTES = 32_768; // 32 KiB
const TAIL_KEEP_BYTES = 8_192; // 8 KiB

function truncateForFts(content: string): string {
  const originalSize = Buffer.byteLength(content, "utf8");
  if (originalSize <= TRUNCATE_THRESHOLD_BYTES) {
    return content;
  }
  const buf = Buffer.from(content, "utf8");
  // toString("utf8") replaces partial multibyte sequences at slice boundaries
  // with U+FFFD — acceptable for FTS indexing.
  const head = buf.subarray(0, HEAD_KEEP_BYTES).toString("utf8");
  const tail = buf.subarray(buf.length - TAIL_KEEP_BYTES).toString("utf8");
  const droppedBytes = originalSize - HEAD_KEEP_BYTES - TAIL_KEEP_BYTES;
  return `${head}\n\n…[FTS_TRUNCATED bytes=${droppedBytes} original_size=${originalSize}]…\n\n${tail}`;
}

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
      const rawContent = extractText(msg.content);
      if (!rawContent) continue;

      const content = role === "user" ? rawContent : truncateForFts(rawContent);
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
