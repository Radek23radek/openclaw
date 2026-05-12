import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { FtsStore } from "../memory/fts-store.js";
import { memorySearch, memorySearchToolDefinition } from "./memory-search-tool.js";

// Stub resolveAgentWorkspaceDir to use a temp directory
vi.mock("../agents/agent-scope.js", () => ({
  resolveAgentWorkspaceDir: (_cfg: unknown, _agentId: string) => tmpDir,
}));

let tmpDir: string;
let store: FtsStore;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-search-test-"));
  // Pre-populate the DB with test data
  store = FtsStore.open(path.join(tmpDir, "state.db"));
  store.ensureSession("sess-a", "claude-sonnet-4-6");
  store.insertMessage({
    sessionId: "sess-a",
    role: "user",
    content: "How do I configure Kubernetes ingress?",
  });
  store.insertMessage({
    sessionId: "sess-a",
    role: "assistant",
    content: "Use kubectl apply -f ingress.yaml with the nginx ingress controller.",
  });
  store.ensureSession("sess-b");
  store.insertMessage({
    sessionId: "sess-b",
    role: "user",
    content: "What is Docker Compose and how does it differ from Kubernetes?",
  });
  store.close();
  // memorySearch will reopen the store via getOrOpenStore
});

afterEach(() => {
  // Clear the internal singleton map between tests
  // (module-level map persists across tests in the same file)
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const fakeConfig: OpenClawConfig = {};

describe("memorySearch", () => {
  it("returns matching results for a simple keyword", () => {
    const result = memorySearch({ query: "kubernetes" }, fakeConfig, "main");
    expect(result.found).toBeGreaterThanOrEqual(1);
    expect(result.results[0]!.snippet).toBeTruthy();
  });

  it("returns found: 0 for no match", () => {
    const result = memorySearch({ query: "postgresql" }, fakeConfig, "main");
    expect(result.found).toBe(0);
    expect(result.results).toHaveLength(0);
  });

  it("respects sessionId filter", () => {
    const result = memorySearch({ query: "kubernetes", sessionId: "sess-b" }, fakeConfig, "main");
    expect(result.results.every((r) => r.sessionId === "sess-b")).toBe(true);
  });

  it("respects roles filter — user only", () => {
    const result = memorySearch(
      { query: "kubernetes OR ingress", roles: ["user"] },
      fakeConfig,
      "main",
    );
    expect(result.results.every((r) => r.role === "user")).toBe(true);
  });

  it("respects limit", () => {
    const result = memorySearch(
      { query: "kubernetes OR ingress OR docker", limit: 1 },
      fakeConfig,
      "main",
    );
    expect(result.results.length).toBeLessThanOrEqual(1);
  });

  it("truncates long content to 500 chars", () => {
    const longContent = "kubernetes ".repeat(100);
    const localStore = FtsStore.open(path.join(tmpDir, "state.db"));
    localStore.ensureSession("sess-long");
    localStore.insertMessage({ sessionId: "sess-long", role: "user", content: longContent });
    localStore.close();

    const result = memorySearch({ query: "kubernetes" }, fakeConfig, "main");
    expect(result.results.every((r) => r.content.length <= 500)).toBe(true);
  });

  it("formats timestamp as human-readable string", () => {
    const result = memorySearch({ query: "kubernetes" }, fakeConfig, "main");
    expect(result.results[0]!.timestamp).toMatch(/\d{4}/);
  });

  it("includes model from session metadata", () => {
    const result = memorySearch({ query: "ingress", sessionId: "sess-a" }, fakeConfig, "main");
    expect(result.results.some((r) => r.model === "claude-sonnet-4-6")).toBe(true);
  });
});

describe("memorySearchToolDefinition", () => {
  it("has correct name", () => {
    expect(memorySearchToolDefinition.name).toBe("memory_search");
  });

  it("requires query parameter", () => {
    expect(memorySearchToolDefinition.inputSchema.required).toContain("query");
  });

  it("has description", () => {
    expect(memorySearchToolDefinition.description.length).toBeGreaterThan(20);
  });
});
