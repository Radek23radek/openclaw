import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetFtsStoreCacheForTest } from "../../memory/fts-store-cache.js";
import { persistTurnMessagesToFts } from "./turn-fts-persistence.js";

let tmpDir: string;

vi.mock("../agent-scope.js", () => ({
  resolveAgentWorkspaceDir: () => tmpDir,
}));

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "turn-fts-test-"));
});

afterEach(() => {
  resetFtsStoreCacheForTest();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function userMsg(content: string, ts = 0): AgentMessage {
  return { role: "user", content, timestamp: ts } as AgentMessage;
}

function assistantMsg(content: string, ts = 0): AgentMessage {
  return { role: "assistant", content, timestamp: ts } as AgentMessage;
}

function readAllInserted(): Array<{ role: string; content: string }> {
  // Read the underlying messages table directly to avoid FTS query syntax quirks.
  // The store cache has already closed/reopened the DB by the time this runs.
  const Database = require("better-sqlite3") as typeof import("better-sqlite3");
  const db = new Database(path.join(tmpDir, "state.db"), { readonly: true });
  try {
    return db.prepare("SELECT role, content FROM messages ORDER BY id ASC").all() as Array<{
      role: string;
      content: string;
    }>;
  } finally {
    db.close();
  }
}

describe("persistTurnMessagesToFts", () => {
  it("inserts new user and assistant messages", () => {
    const count = persistTurnMessagesToFts({
      sessionId: "s1",
      agentId: "main",
      config: {},
      messagesSnapshot: [userMsg("hello"), assistantMsg("hi there")],
      prePromptMessageCount: 0,
    });
    expect(count).toBe(2);
  });

  it("only inserts messages at or after prePromptMessageCount", () => {
    const snapshot = [
      userMsg("old-1"),
      assistantMsg("old-2"),
      userMsg("new-1"),
      assistantMsg("new-2"),
    ];
    const count = persistTurnMessagesToFts({
      sessionId: "s2",
      agentId: "main",
      config: {},
      messagesSnapshot: snapshot,
      prePromptMessageCount: 2,
    });
    expect(count).toBe(2);
  });

  it("returns 0 when there are no new messages", () => {
    const count = persistTurnMessagesToFts({
      sessionId: "s3",
      agentId: "main",
      config: {},
      messagesSnapshot: [userMsg("hi")],
      prePromptMessageCount: 1,
    });
    expect(count).toBe(0);
  });

  it("skips tool-role and empty-content messages", () => {
    const messages: AgentMessage[] = [
      userMsg("real-user"),
      { role: "tool", content: "tool output", timestamp: 0 } as AgentMessage,
      userMsg(""),
      assistantMsg("real-assistant"),
    ];
    const count = persistTurnMessagesToFts({
      sessionId: "s4",
      agentId: "main",
      config: {},
      messagesSnapshot: messages,
      prePromptMessageCount: 0,
    });
    expect(count).toBe(2);
  });

  it("extracts text from content blocks (assistant with TextContent[])", () => {
    const message: AgentMessage = {
      role: "assistant",
      content: [
        { type: "text", text: "Hello" },
        { type: "text", text: "World" },
      ],
      timestamp: 0,
    } as AgentMessage;
    const count = persistTurnMessagesToFts({
      sessionId: "s5",
      agentId: "main",
      config: {},
      messagesSnapshot: [message],
      prePromptMessageCount: 0,
    });
    expect(count).toBe(1);
    const all = readAllInserted();
    expect(all[0]!.content).toContain("Hello");
    expect(all[0]!.content).toContain("World");
  });

  it("never throws when the workspace path is invalid", () => {
    // Force a bad workspace path
    tmpDir = "/nonexistent/path/that/does/not/exist";
    expect(() =>
      persistTurnMessagesToFts({
        sessionId: "s6",
        agentId: "main",
        config: {},
        messagesSnapshot: [userMsg("test")],
        prePromptMessageCount: 0,
      }),
    ).not.toThrow();
  });

  it("inserts are idempotent across calls when prePromptMessageCount advances", () => {
    // Simulate two consecutive turns
    persistTurnMessagesToFts({
      sessionId: "s7",
      agentId: "main",
      config: {},
      messagesSnapshot: [userMsg("q1"), assistantMsg("a1")],
      prePromptMessageCount: 0,
    });
    persistTurnMessagesToFts({
      sessionId: "s7",
      agentId: "main",
      config: {},
      messagesSnapshot: [userMsg("q1"), assistantMsg("a1"), userMsg("q2"), assistantMsg("a2")],
      prePromptMessageCount: 2,
    });
    const all = readAllInserted();
    expect(all.length).toBe(4);
    const contents = all.map((m) => m.content).sort();
    expect(contents).toEqual(["a1", "a2", "q1", "q2"]);
  });
});
