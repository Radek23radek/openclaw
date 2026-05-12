import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAsBackgroundReview } from "../skills/skill-provenance.js";
import {
  createSkillReviewTool,
  executeSkillReviewAction,
  REVIEW_ALLOWED_ACTIONS,
  SkillReviewToolParamsSchema,
} from "./skill-review-tool.js";
import { EMPTY_REVIEW_RESULT, isEmptyReview, type ReviewResult } from "./skill-review-types.js";

let tmpDir: string;

// Redirect CONFIG_DIR to a temp dir for the underlying skillManage calls.
vi.mock("../../utils.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../../utils.js")>();
  return {
    ...orig,
    get CONFIG_DIR() {
      return tmpDir;
    },
  };
});

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "skill-review-tool-test-"));
  fs.mkdirSync(path.join(tmpDir, "skills"), { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ===========================================================================
// Schema shape: only 3 actions, never "list"
// ===========================================================================

describe("SkillReviewToolParamsSchema — surface", () => {
  it("exposes exactly 3 actions: create, update, delete", () => {
    expect([...REVIEW_ALLOWED_ACTIONS].sort()).toEqual(["create", "delete", "update"]);
  });

  it('does NOT expose "list" — review never queries the catalog (pre-injected snapshot)', () => {
    expect(REVIEW_ALLOWED_ACTIONS as readonly string[]).not.toContain("list");
  });

  it("schema action field is a flat enum (not anyOf — providers reject anyOf)", () => {
    const actionSchema = (SkillReviewToolParamsSchema.properties as Record<string, unknown>)
      .action as {
      type?: string;
      enum?: string[];
      anyOf?: unknown;
    };
    expect(actionSchema.type).toBe("string");
    expect(actionSchema.enum).toEqual(["create", "update", "delete"]);
    expect(actionSchema.anyOf).toBeUndefined();
  });

  it("schema required fields: only action and name", () => {
    expect(SkillReviewToolParamsSchema.required).toEqual(["action", "name"]);
  });
});

// ===========================================================================
// executeSkillReviewAction — happy paths
// ===========================================================================

describe("executeSkillReviewAction — happy paths", () => {
  it("create returns { result: 'created' } and writes SKILL.md", () => {
    const log = executeSkillReviewAction({
      action: "create",
      name: "k8s-deploy",
      description: "Kubernetes deployment workflow",
      content: "## Workflow\n\nApply manifests with kubectl.",
      rationale: "User repeated this pattern 3x in conversation",
    });
    expect(log).toEqual({ action: "create", name: "k8s-deploy", result: "created" });
    expect(fs.existsSync(path.join(tmpDir, "skills", "k8s-deploy", "SKILL.md"))).toBe(true);
  });

  it("update rewrites an existing skill", () => {
    executeSkillReviewAction({
      action: "create",
      name: "k8s",
      description: "K8s",
      content: "# Original",
    });
    const log = executeSkillReviewAction({
      action: "update",
      name: "k8s",
      content: "# Updated\n\nNew content.",
    });
    expect(log.result).toBe("updated");
    const stored = fs.readFileSync(path.join(tmpDir, "skills", "k8s", "SKILL.md"), "utf8");
    expect(stored).toContain("Updated");
  });

  it("delete removes an agent-created skill", async () => {
    await runAsBackgroundReview(async () => {
      executeSkillReviewAction({
        action: "create",
        name: "ephemeral",
        description: "D",
        content: "C",
      });
    });
    const log = executeSkillReviewAction({ action: "delete", name: "ephemeral" });
    expect(log.result).toBe("deleted");
    expect(fs.existsSync(path.join(tmpDir, "skills", "ephemeral"))).toBe(false);
  });
});

// ===========================================================================
// executeSkillReviewAction — error paths return "skipped", never throw
// ===========================================================================

describe("executeSkillReviewAction — error paths (NEVER throw)", () => {
  it("create without description → skipped with reason", () => {
    const log = executeSkillReviewAction({
      action: "create",
      name: "x",
      content: "c",
    });
    expect(log.result).toBe("skipped");
    expect(log.reason).toContain("description");
  });

  it("create without content → skipped", () => {
    const log = executeSkillReviewAction({
      action: "create",
      name: "x",
      description: "d",
    });
    expect(log.result).toBe("skipped");
    expect(log.reason).toContain("content");
  });

  it("update without content → skipped", () => {
    const log = executeSkillReviewAction({ action: "update", name: "x" });
    expect(log.result).toBe("skipped");
    expect(log.reason).toContain("content");
  });

  it("missing name (empty string) → skipped", () => {
    const log = executeSkillReviewAction({
      action: "create",
      name: "",
      description: "d",
      content: "c",
    });
    expect(log.result).toBe("skipped");
    expect(log.reason).toContain("name");
  });

  it("invalid name (uppercase) → skipped with reason from skillManage", () => {
    const log = executeSkillReviewAction({
      action: "create",
      name: "BadName",
      description: "d",
      content: "c",
    });
    expect(log.result).toBe("skipped");
    expect(log.reason).toMatch(/lowercase|name must/);
  });

  it("delete of a user-created skill → skipped (protection from Module 3)", () => {
    // User-created (NOT in background review context)
    executeSkillReviewAction({
      action: "create",
      name: "user-skill",
      description: "d",
      content: "c",
    });
    const log = executeSkillReviewAction({ action: "delete", name: "user-skill" });
    expect(log.result).toBe("skipped");
    expect(log.reason).toMatch(/user|cannot be deleted/);
  });

  it("delete of nonexistent skill → skipped", () => {
    const log = executeSkillReviewAction({ action: "delete", name: "ghost" });
    expect(log.result).toBe("skipped");
    expect(log.reason).toMatch(/not found/);
  });

  it("update of nonexistent skill → skipped", () => {
    const log = executeSkillReviewAction({
      action: "update",
      name: "ghost",
      content: "c",
    });
    expect(log.result).toBe("skipped");
    expect(log.reason).toMatch(/not found/);
  });

  it("content over 32 KiB cap → skipped (G2 inherited from Module 3)", () => {
    const huge = "x".repeat(33_000);
    const log = executeSkillReviewAction({
      action: "create",
      name: "huge",
      description: "d",
      content: huge,
    });
    expect(log.result).toBe("skipped");
    expect(log.reason).toMatch(/exceeds limit/);
  });
});

// ===========================================================================
// Provenance — review writes are tagged agent_created: true
// ===========================================================================

describe("executeSkillReviewAction — provenance tagging", () => {
  it("when called inside runAsBackgroundReview, skill is agent_created: true", async () => {
    await runAsBackgroundReview(async () => {
      executeSkillReviewAction({
        action: "create",
        name: "agent-made",
        description: "d",
        content: "c",
      });
    });
    const fm = fs.readFileSync(path.join(tmpDir, "skills", "agent-made", "SKILL.md"), "utf8");
    expect(fm).toContain("agent_created: true");
  });

  it("outside background review (regression guard), skill is agent_created: false", () => {
    executeSkillReviewAction({
      action: "create",
      name: "user-direct",
      description: "d",
      content: "c",
    });
    const fm = fs.readFileSync(path.join(tmpDir, "skills", "user-direct", "SKILL.md"), "utf8");
    expect(fm).toContain("agent_created: false");
  });
});

// ===========================================================================
// createSkillReviewTool — pi-coding-agent ToolDefinition wrapper
// ===========================================================================

describe("createSkillReviewTool — pi-coding-agent wrapper", () => {
  it("returns a tool named 'skill_manage' (matches Hermes prompt)", () => {
    const tool = createSkillReviewTool();
    expect(tool.name).toBe("skill_manage");
  });

  it("has a non-empty description for the LLM", () => {
    const tool = createSkillReviewTool();
    expect(tool.description.length).toBeGreaterThan(20);
  });

  it("execute() wraps executeSkillReviewAction and returns JSON-result text", async () => {
    const tool = createSkillReviewTool();
    const result = await tool.execute("call-1", {
      action: "create",
      name: "wrap-test",
      description: "d",
      content: "c",
    });
    // jsonResult returns { content: [{ type:"text", text: <JSON> }], ... }
    const text = (result.content?.[0] as { text?: string } | undefined)?.text ?? "";
    const parsed = JSON.parse(text);
    expect(parsed).toEqual({ action: "create", name: "wrap-test", result: "created" });
  });

  it("execute() returns skipped outcome (NOT throws) on invalid input", async () => {
    const tool = createSkillReviewTool();
    await expect(
      tool.execute("call-2", { action: "create", name: "bad", description: "d" }),
    ).resolves.toBeDefined();
  });
});

// ===========================================================================
// ReviewResult helpers
// ===========================================================================

describe("ReviewResult helpers", () => {
  it("EMPTY_REVIEW_RESULT has all counters at 0", () => {
    expect(EMPTY_REVIEW_RESULT.skillsCreated).toBe(0);
    expect(EMPTY_REVIEW_RESULT.skillsUpdated).toBe(0);
    expect(EMPTY_REVIEW_RESULT.skillsDeleted).toBe(0);
    expect(EMPTY_REVIEW_RESULT.skipped).toBe(0);
    expect(EMPTY_REVIEW_RESULT.textOutput).toBe("");
  });

  it("isEmptyReview true when no skills mutated (skipped does NOT count as content)", () => {
    const r: ReviewResult = {
      skillsCreated: 0,
      skillsUpdated: 0,
      skillsDeleted: 0,
      skipped: 5, // model tried but everything was rejected
      textOutput: "Nothing to save.",
    };
    expect(isEmptyReview(r)).toBe(true);
  });

  it("isEmptyReview false when at least one skill was created/updated/deleted", () => {
    expect(isEmptyReview({ ...EMPTY_REVIEW_RESULT, skillsCreated: 1 })).toBe(false);
    expect(isEmptyReview({ ...EMPTY_REVIEW_RESULT, skillsUpdated: 1 })).toBe(false);
    expect(isEmptyReview({ ...EMPTY_REVIEW_RESULT, skillsDeleted: 1 })).toBe(false);
  });
});
