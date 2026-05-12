import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FtsStore, sanitizeFts5Query } from "./fts-store.js";

// --- sanitizeFts5Query ---

describe("sanitizeFts5Query", () => {
  it("returns empty string for blank input", () => {
    expect(sanitizeFts5Query("")).toBe("");
    expect(sanitizeFts5Query("   ")).toBe("");
  });

  it("passes through simple keywords unchanged", () => {
    expect(sanitizeFts5Query("docker deployment")).toBe("docker deployment");
  });

  it("preserves balanced quoted phrases", () => {
    expect(sanitizeFts5Query('"exact phrase"')).toBe('"exact phrase"');
  });

  it("strips unmatched FTS5-special characters", () => {
    const result = sanitizeFts5Query("hello(world)");
    expect(result).not.toContain("(");
    expect(result).not.toContain(")");
    expect(result).toContain("hello");
    expect(result).toContain("world");
  });

  it("removes leading dangling AND/OR/NOT", () => {
    expect(sanitizeFts5Query("AND hello")).toBe("hello");
    expect(sanitizeFts5Query("OR world")).toBe("world");
  });

  it("removes trailing dangling AND/OR/NOT", () => {
    expect(sanitizeFts5Query("hello AND")).toBe("hello");
  });

  it("wraps hyphenated terms in quotes so FTS5 treats them as phrases", () => {
    const result = sanitizeFts5Query("chat-send");
    expect(result).toBe('"chat-send"');
  });

  it("wraps dotted terms in quotes", () => {
    const result = sanitizeFts5Query("config.yaml");
    expect(result).toBe('"config.yaml"');
  });

  it("does not double-quote already-quoted phrases", () => {
    const result = sanitizeFts5Query('"chat-send"');
    // preserved as-is, not wrapped again
    expect(result).toBe('"chat-send"');
  });

  it("preserves FTS5 boolean operators in the middle", () => {
    const result = sanitizeFts5Query("docker OR kubernetes");
    expect(result).toBe("docker OR kubernetes");
  });

  it("handles prefix wildcard", () => {
    const result = sanitizeFts5Query("deploy*");
    expect(result).toBe("deploy*");
  });

  it("collapses repeated wildcards", () => {
    const result = sanitizeFts5Query("foo***");
    expect(result).toBe("foo*");
  });
});

// --- FtsStore ---

function makeTmpDb(): { store: FtsStore; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fts-store-test-"));
  const store = FtsStore.open(path.join(dir, "state.db"));
  return { store, dir };
}

describe("FtsStore", () => {
  let store: FtsStore;
  let tmpDir: string;

  beforeEach(() => {
    ({ store, dir: tmpDir } = makeTmpDb());
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("opens a new database and creates schema", () => {
    // No error thrown → schema created successfully
    expect(store).toBeDefined();
  });

  it("can be opened twice on the same path (second call returns fresh store)", () => {
    store.close();
    const store2 = FtsStore.open(path.join(tmpDir, "state.db"));
    expect(store2).toBeDefined();
    store2.close();
    // Reopen so afterEach close() doesn't fail
    store = FtsStore.open(path.join(tmpDir, "state.db"));
  });

  describe("insertMessage + search", () => {
    beforeEach(() => {
      store.ensureSession("sess-1", "claude-sonnet-4-6");
      store.insertMessage({
        sessionId: "sess-1",
        role: "user",
        content: "How do I deploy a Docker container to Kubernetes?",
      });
      store.insertMessage({
        sessionId: "sess-1",
        role: "assistant",
        content: "You can use kubectl apply with a deployment manifest.",
      });
    });

    it("finds a message by keyword", () => {
      const results = store.search("docker");
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0]!.content).toContain("Docker");
    });

    it("returns empty array for no match", () => {
      const results = store.search("postgresql");
      expect(results).toHaveLength(0);
    });

    it("returns empty array for blank query", () => {
      expect(store.search("")).toHaveLength(0);
      expect(store.search("   ")).toHaveLength(0);
    });

    it("finds across multiple messages", () => {
      const results = store.search("kubectl");
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0]!.role).toBe("assistant");
    });

    it("respects sessionId filter", () => {
      store.ensureSession("sess-2");
      store.insertMessage({
        sessionId: "sess-2",
        role: "user",
        content: "Docker question in session 2",
      });

      const inSess1 = store.search("Docker", { sessionId: "sess-1" });
      const inSess2 = store.search("Docker", { sessionId: "sess-2" });

      expect(inSess1.every((r) => r.sessionId === "sess-1")).toBe(true);
      expect(inSess2.every((r) => r.sessionId === "sess-2")).toBe(true);
    });

    it("respects roleFilter", () => {
      const userOnly = store.search("kubernetes OR kubectl", {
        roleFilter: ["user"],
      });
      expect(userOnly.every((r) => r.role === "user")).toBe(true);
    });

    it("respects limit", () => {
      // Insert more messages
      for (let i = 0; i < 10; i++) {
        store.insertMessage({
          sessionId: "sess-1",
          role: "user",
          content: `Message about docker number ${i}`,
        });
      }
      const results = store.search("docker", { limit: 3 });
      expect(results.length).toBeLessThanOrEqual(3);
    });

    it("snippet contains match markers", () => {
      const results = store.search("Docker");
      // FTS5 snippet wraps matching terms in >>> / <<<
      expect(results.some((r) => r.snippet.includes(">>>"))).toBe(true);
    });

    it("includes session metadata in results", () => {
      const results = store.search("docker");
      expect(results[0]!.model).toBe("claude-sonnet-4-6");
      expect(results[0]!.sessionStartedAt).toBeGreaterThan(0);
    });
  });

  describe("FTS5 query sanitization integration", () => {
    beforeEach(() => {
      store.ensureSession("sess-safe");
      store.insertMessage({
        sessionId: "sess-safe",
        role: "user",
        content: "Testing chat-send and config.yaml file",
      });
    });

    it("survives queries with unmatched special chars without throwing", () => {
      expect(() => store.search("(broken query)")).not.toThrow();
    });

    it("matches hyphenated term wrapped in quotes by sanitizer", () => {
      const results = store.search("chat-send");
      expect(results.length).toBeGreaterThanOrEqual(1);
    });

    it("survives dangling boolean operators without throwing", () => {
      expect(() => store.search("AND")).not.toThrow();
      expect(() => store.search("OR")).not.toThrow();
    });
  });

  describe("CJK trigram routing", () => {
    beforeEach(() => {
      store.ensureSession("sess-cjk");
      store.insertMessage({
        sessionId: "sess-cjk",
        role: "user",
        content: "关于大别山项目的部署问题",
      });
    });

    it("finds CJK content via trigram table (≥3 CJK chars)", () => {
      const results = store.search("大别山");
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0]!.content).toContain("大别山");
    });
  });
});
