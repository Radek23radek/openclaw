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

  it("merges model-supplied frontmatter with our provenance fields", () => {
    // The model may write its own frontmatter. version (author metadata) is
    // kept as-is; agent_created (provenance) is always injected by us.
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
    expect(written).toContain("version: 2.0.0"); // model wins — author metadata
    expect(written).toContain("agent_created: false"); // provenance — always injected
    expect(written).toContain("# Custom"); // body preserved
  });

  it("injects agent_created: true when model supplies frontmatter in background review", async () => {
    await runAsBackgroundReview(async () => {
      skillManage({
        action: "create",
        name: "fm-bg-skill",
        description: "bg",
        content: "---\nname: fm-bg-skill\ndescription: bg\n---\n# Body",
      });
    });
    const written = fs.readFileSync(path.join(tmpDir, "skills", "fm-bg-skill", "SKILL.md"), "utf8");
    expect(written).toContain("agent_created: true");
  });

  it("overrides a model-written agent_created with the real provenance", async () => {
    // A model that writes agent_created: false in its content must not be
    // able to spoof provenance — our value (background review → true) wins.
    await runAsBackgroundReview(async () => {
      skillManage({
        action: "create",
        name: "spoof-skill",
        description: "spoof",
        content: "---\nname: spoof-skill\ndescription: spoof\nagent_created: false\n---\n# Body",
      });
    });
    const written = fs.readFileSync(path.join(tmpDir, "skills", "spoof-skill", "SKILL.md"), "utf8");
    expect(written).toContain("agent_created: true");
    expect(written).not.toContain("agent_created: false");
  });

  it("preserves model-supplied non-provenance fields (category, tags)", () => {
    skillManage({
      action: "create",
      name: "extra-fields-skill",
      description: "extras",
      content:
        "---\nname: extra-fields-skill\ndescription: extras\ncategory: search\ntags: [a, b]\n---\n# Body",
    });
    const written = fs.readFileSync(
      path.join(tmpDir, "skills", "extra-fields-skill", "SKILL.md"),
      "utf8",
    );
    expect(written).toContain("category: search");
    expect(written).toContain("tags: [a, b]");
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

  it("preserves agent_created: true from the original on update", async () => {
    await runAsBackgroundReview(async () => {
      skillManage({ action: "create", name: "agent-upd", description: "d", content: "# Orig" });
    });
    // Update runs in a foreground context — provenance must NOT flip to false.
    skillManage({ action: "update", name: "agent-upd", content: "# Updated" });
    const written = fs.readFileSync(path.join(tmpDir, "skills", "agent-upd", "SKILL.md"), "utf8");
    expect(written).toContain("agent_created: true");
    expect(written).toContain("# Updated");
  });

  it("takes provenance from the original file, not the update content frontmatter", () => {
    // "updatable" was created user-directed (agent_created: false) in beforeEach.
    // An update whose content tries to assert agent_created: true is ignored.
    skillManage({
      action: "update",
      name: "updatable",
      content: "---\nname: updatable\nagent_created: true\n---\n# Sneaky update",
    });
    const written = fs.readFileSync(path.join(tmpDir, "skills", "updatable", "SKILL.md"), "utf8");
    expect(written).toContain("agent_created: false");
    expect(written).toContain("# Sneaky update");
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
