// Portions derived from Hermes Agent (MIT) - NousResearch
// https://github.com/NousResearch/hermes-agent
//
// memory_search tool: exposes FtsStore to the agent for cross-session recall.

import path from "node:path";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { FtsStore, type SearchResult } from "../memory/fts-store.js";

// Singleton FtsStore per workspace path, closed on process exit.
const _stores = new Map<string, FtsStore>();

function getOrOpenStore(workspaceDir: string): FtsStore {
  const dbPath = path.join(workspaceDir, "state.db");
  let store = _stores.get(dbPath);
  if (!store) {
    store = FtsStore.open(dbPath);
    _stores.set(dbPath, store);
  }
  return store;
}

process.on("exit", () => {
  for (const store of _stores.values()) {
    try {
      store.close();
    } catch {
      // best-effort on exit
    }
  }
});

export type MemorySearchParams = {
  query: string;
  sessionId?: string;
  roles?: string[];
  limit?: number;
};

export type MemorySearchResult = {
  found: number;
  results: FormattedResult[];
};

type FormattedResult = {
  sessionId: string;
  role: string;
  snippet: string;
  content: string;
  timestamp: string;
  model: string | null;
};

function formatTimestamp(ts: number): string {
  return new Date(ts * 1000).toLocaleString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatResult(r: SearchResult): FormattedResult {
  return {
    sessionId: r.sessionId,
    role: r.role,
    snippet: r.snippet,
    content: r.content.slice(0, 500),
    timestamp: formatTimestamp(r.ts),
    model: r.model,
  };
}

/**
 * Searches the per-workspace FTS5 memory store.
 *
 * Called by the agent via the memory_search tool definition.
 * Resolves the workspace path from config, opens (or reuses) the store,
 * and returns formatted results.
 */
export function memorySearch(
  params: MemorySearchParams,
  config: OpenClawConfig,
  agentId: string,
): MemorySearchResult {
  const workspaceDir = resolveAgentWorkspaceDir(config, agentId);
  const store = getOrOpenStore(workspaceDir);

  const raw: SearchResult[] = store.search(params.query, {
    sessionId: params.sessionId,
    roleFilter: params.roles,
    limit: params.limit ?? 20,
  });

  return {
    found: raw.length,
    results: raw.map(formatResult),
  };
}

/**
 * Tool definition object compatible with OpenClaw's tool registry.
 * Agents with learning.enabled can call this as "memory_search".
 */
export const memorySearchToolDefinition = {
  name: "memory_search",
  description:
    "Search past conversation history in this workspace using full-text search (FTS5). " +
    "Returns matching messages with snippets showing the context. " +
    "Supports keywords, phrases (quoted), boolean operators (OR, AND, NOT), and prefix wildcards (word*).",
  inputSchema: {
    type: "object" as const,
    properties: {
      query: {
        type: "string",
        description:
          'Search query. Supports FTS5 syntax: keywords, "exact phrases", word* prefix, OR/AND/NOT.',
      },
      session_id: {
        type: "string",
        description: "Optional: restrict search to a specific session ID.",
      },
      roles: {
        type: "array",
        items: { type: "string", enum: ["user", "assistant", "tool"] },
        description: "Optional: filter by message role.",
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 50,
        description: "Max results to return (default: 20).",
      },
    },
    required: ["query"],
  },
} as const;
