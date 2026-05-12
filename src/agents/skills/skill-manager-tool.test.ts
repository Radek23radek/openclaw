import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { skillManage, type SkillListEntry, type SkillManageResult } from "./skill-manager-tool.js";
import { runAsBackgroundReview } from "./skill-provenance.js";

// Redirect CONFIG_DIR to a temp directory for all tests
let tmpDir: string;
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "skill-manager-test-"));
  fs.mkdirSync(path.join(tmpDir, "skills"), { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("skill_manage — create", () => {
  it("creates a SKILL.md file with auto frontmatter", () => {
    const result = skillManage({
      action: "create",
      name: "my-skill",
      description: "Does something useful",
      content: "## Workflow\n\nDo the thing.",
    }) as SkillManageResult;

    expect(result.ok).toBe(true);
    const filePath = path.join(tmpDir, "skills", "my-skill", "SKILL.md");
    expect(fs.existsSync(filePath)).toBe(true);
    const written = fs.readFileSync(filePath, "utf8");
    expect(written).toContain("name: my-skill");
    expect(written).toContain("agent_created: false");
    expect(written).toContain("## Workflow");
  });

  it("marks skill as agent_created when called from background review context", async () => {
    await runAsBackgroundReview(async () => {
      skillManage({
        action: "create",
        name: "auto-skill",
        description: "Auto-generated",
        content: "## Steps\n\nSome steps.",
      });
    });

    const filePath = path.join(tmpDir, "skills", "auto-skill", "SKILL.md");
    const written = fs.readFileSync(filePath, "utf8");
    expect(written).toContain("agent_created: true");
  });

  it("rejects invalid name (uppercase)", () => {
    const result = skillManage({
      action: "create",
      name: "MySkill",
      description: "desc",
      content: "content",
    }) as SkillManageResult;
    expect(result.ok).toBe(false);
    expect(result.error).toContain("name must match");
  });

  it("rejects name with path traversal", () => {
    const result = skillManage({
      action: "create",
      name: "../evil",
      description: "desc",
      content: "content",
    }) as SkillManageResult;
    expect(result.ok).toBe(false);
  });

  it("rejects duplicate skill name", () => {
    skillManage({ action: "create", name: "dup-skill", description: "d", content: "c" });
    const result = skillManage({
      action: "create",
      name: "dup-skill",
      description: "d2",
      content: "c2",
    }) as SkillManageResult;
    expect(result.ok).toBe(false);
    expect(result.error).toContain("already exists");
  });

  it("rejects content over 32 KiB", () => {
    const bigContent = "x".repeat(33_000);
    const result = skillManage({
      action: "create",
      name: "big-skill",
      description: "desc",
      content: bigContent,
    }) as SkillManageResult;
    expect(result.ok).toBe(false);
    expect(result.error).toContain("exceeds limit");
  });

  it("uses provided frontmatter when content starts with ---", () => {
    const customContent =
      "---\nname: custom-fm\ndescription: custom\nversion: 2.0.0\n---\n# Custom";
    skillManage({
      action: "create",
      name: "custom-fm-skill",
      description: "custom",
      content: customContent,
    });
    const filePath = path.join(tmpDir, "skills", "custom-fm-skill", "SKILL.md");
    const written = fs.readFileSync(filePath, "utf8");
    expect(written).toContain("version: 2.0.0");
    expect(written).not.toContain("agent_created");
  });
});

describe("skill_manage — update", () => {
  beforeEach(() => {
    skillManage({
      action: "create",
      name: "updatable",
      description: "original",
      content: "# Original",
    });
  });

  it("updates an existing skill", () => {
    const result = skillManage({
      action: "update",
      name: "updatable",
      content: "# Updated content",
    }) as SkillManageResult;
    expect(result.ok).toBe(true);
    const filePath = path.join(tmpDir, "skills", "updatable", "SKILL.md");
    expect(fs.readFileSync(filePath, "utf8")).toContain("# Updated content");
  });

  it("returns error for non-existent skill", () => {
    const result = skillManage({
      action: "update",
      name: "nonexistent",
      content: "content",
    }) as SkillManageResult;
    expect(result.ok).toBe(false);
    expect(result.error).toContain("not found");
  });
});

describe("skill_manage — delete", () => {
  it("deletes an agent-created skill", async () => {
    await runAsBackgroundReview(async () => {
      skillManage({ action: "create", name: "deletable", description: "d", content: "c" });
    });

    const result = skillManage({ action: "delete", name: "deletable" }) as SkillManageResult;
    expect(result.ok).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "skills", "deletable"))).toBe(false);
  });

  it("rejects deletion of user-created skill", () => {
    skillManage({ action: "create", name: "user-skill", description: "d", content: "c" });

    const result = skillManage({ action: "delete", name: "user-skill" }) as SkillManageResult;
    expect(result.ok).toBe(false);
    expect(result.error).toContain("user");
  });

  it("returns error for non-existent skill", () => {
    const result = skillManage({ action: "delete", name: "ghost" }) as SkillManageResult;
    expect(result.ok).toBe(false);
    expect(result.error).toContain("not found");
  });
});

describe("skill_manage — list", () => {
  it("returns empty list when no skills exist", () => {
    const result = skillManage({ action: "list" }) as SkillListEntry[];
    expect(result).toHaveLength(0);
  });

  it("lists created skills with metadata", () => {
    skillManage({ action: "create", name: "skill-a", description: "Alpha skill", content: "# A" });
    skillManage({ action: "create", name: "skill-b", description: "Beta skill", content: "# B" });

    const result = skillManage({ action: "list" }) as SkillListEntry[];
    expect(result.length).toBe(2);
    const names = result.map((s) => s.name);
    expect(names).toContain("skill-a");
    expect(names).toContain("skill-b");
  });

  it("distinguishes agent-created from user-created", async () => {
    skillManage({ action: "create", name: "user-s", description: "user", content: "u" });
    await runAsBackgroundReview(async () => {
      skillManage({ action: "create", name: "agent-s", description: "agent", content: "a" });
    });

    const result = skillManage({ action: "list" }) as SkillListEntry[];
    const userSkill = result.find((s) => s.name === "user-s");
    const agentSkill = result.find((s) => s.name === "agent-s");
    expect(userSkill?.agentCreated).toBe(false);
    expect(agentSkill?.agentCreated).toBe(true);
  });
});
