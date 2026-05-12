// Portions derived from Hermes Agent (MIT) - NousResearch
// https://github.com/NousResearch/hermes-agent
//
// skill_manage tool: lets the agent create, update, delete, and list SKILL.md files.
// Only available when learning.enabled: true in agent config.
// Agent-created skills are tagged in frontmatter; user-created skills are protected.

import fs from "node:fs";
import path from "node:path";
import { CONFIG_DIR } from "../../utils.js";
import { parseFrontmatter } from "./frontmatter.js";
import { isBackgroundReview } from "./skill-provenance.js";

function getManagedSkillsDir(): string {
  return path.join(CONFIG_DIR, "skills");
}

// Slug pattern: lowercase alphanumeric + hyphens, no traversal chars
const VALID_SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

// Hard limit on SKILL.md content size (agent writes only).
// Prevents runaway LLM output from filling disk.
const MAX_SKILL_CONTENT_BYTES = 32_768;

export type SkillManageAction = "create" | "update" | "delete" | "list";

export type SkillManageParams =
  | { action: "create"; name: string; description: string; content: string }
  | { action: "update"; name: string; content: string }
  | { action: "delete"; name: string }
  | { action: "list" };

export type SkillManageResult = { ok: true; message: string } | { ok: false; error: string };

export type SkillListEntry = {
  name: string;
  description: string;
  version: string;
  agentCreated: boolean;
  path: string;
};

function validateName(name: string): string | null {
  if (!name?.trim()) return "name is required.";
  if (!VALID_SLUG.test(name)) {
    return `name must match ${VALID_SLUG}: lowercase letters, digits, hyphens only. Got: "${name}"`;
  }
  return null;
}

function validateContent(content: string): string | null {
  if (!content?.trim()) return "content is required.";
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > MAX_SKILL_CONTENT_BYTES) {
    return `content exceeds limit (${bytes} > ${MAX_SKILL_CONTENT_BYTES} bytes).`;
  }
  return null;
}

function skillDir(name: string): string {
  return path.join(getManagedSkillsDir(), name);
}

function skillFilePath(name: string): string {
  return path.join(skillDir(name), "SKILL.md");
}

function buildFrontmatter(params: {
  name: string;
  description: string;
  agentCreated: boolean;
}): string {
  const lines = [
    "---",
    `name: ${params.name}`,
    `description: "${params.description.replace(/"/g, '\\"')}"`,
    "version: 1.0.0",
    "platforms: [linux, macos, windows]",
    `agent_created: ${params.agentCreated}`,
    `created_at: "${new Date().toISOString()}"`,
    "---",
    "",
  ];
  return lines.join("\n");
}

function isAgentCreated(skillFilePath: string): boolean {
  try {
    const raw = fs.readFileSync(skillFilePath, "utf8");
    const fm = parseFrontmatter(raw);
    return fm?.agent_created === "true";
  } catch {
    return false;
  }
}

function findSkillByName(name: string): string | null {
  // Check managed dir first, then walk for any SKILL.md with matching name
  const managed = skillFilePath(name);
  if (fs.existsSync(managed)) return path.dirname(managed);

  try {
    const entries = fs.readdirSync(getManagedSkillsDir(), { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(getManagedSkillsDir(), entry.name, "SKILL.md");
      if (!fs.existsSync(candidate)) continue;
      try {
        const raw = fs.readFileSync(candidate, "utf8");
        const fm = parseFrontmatter(raw);
        if (fm?.name === name) return path.join(getManagedSkillsDir(), entry.name);
      } catch {
        // skip unreadable skills
      }
    }
  } catch {
    // managed dir doesn't exist yet
  }
  return null;
}

function createSkill(params: {
  name: string;
  description: string;
  content: string;
}): SkillManageResult {
  const nameErr = validateName(params.name);
  if (nameErr) return { ok: false, error: nameErr };

  const contentErr = validateContent(params.content);
  if (contentErr) return { ok: false, error: contentErr };

  const existing = findSkillByName(params.name);
  if (existing) {
    return {
      ok: false,
      error: `Skill "${params.name}" already exists at ${existing}. Use update to modify it.`,
    };
  }

  const dir = skillDir(params.name);
  fs.mkdirSync(dir, { recursive: true });

  const agentCreated = isBackgroundReview();
  const frontmatter = buildFrontmatter({
    name: params.name,
    description: params.description,
    agentCreated,
  });

  // If content already starts with frontmatter (---), use it as-is.
  // Otherwise prepend auto-generated frontmatter.
  const hasExistingFrontmatter = params.content.trimStart().startsWith("---");
  const finalContent = hasExistingFrontmatter ? params.content : frontmatter + params.content;

  fs.writeFileSync(skillFilePath(params.name), finalContent, "utf8");

  const origin = agentCreated ? "agent-created (background review)" : "user-directed";
  return {
    ok: true,
    message: `Skill "${params.name}" created at ${skillFilePath(params.name)} [${origin}].`,
  };
}

function updateSkill(params: { name: string; content: string }): SkillManageResult {
  const nameErr = validateName(params.name);
  if (nameErr) return { ok: false, error: nameErr };

  const contentErr = validateContent(params.content);
  if (contentErr) return { ok: false, error: contentErr };

  const existingDir = findSkillByName(params.name);
  if (!existingDir) {
    return { ok: false, error: `Skill "${params.name}" not found. Use create to add it.` };
  }

  const filePath = path.join(existingDir, "SKILL.md");
  fs.writeFileSync(filePath, params.content, "utf8");
  return { ok: true, message: `Skill "${params.name}" updated at ${filePath}.` };
}

function deleteSkill(params: { name: string }): SkillManageResult {
  const nameErr = validateName(params.name);
  if (nameErr) return { ok: false, error: nameErr };

  const existingDir = findSkillByName(params.name);
  if (!existingDir) {
    return { ok: false, error: `Skill "${params.name}" not found.` };
  }

  const filePath = path.join(existingDir, "SKILL.md");

  // Only agent-created skills may be auto-deleted.
  // User-created skills are protected even when called from background review.
  if (!isAgentCreated(filePath)) {
    return {
      ok: false,
      error: `Skill "${params.name}" was created by the user and cannot be deleted automatically. Ask the user to remove it manually.`,
    };
  }

  fs.rmSync(existingDir, { recursive: true, force: true });
  return { ok: true, message: `Agent-created skill "${params.name}" deleted.` };
}

function listSkills(): SkillListEntry[] {
  const results: SkillListEntry[] = [];

  try {
    const entries = fs.readdirSync(getManagedSkillsDir(), { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const filePath = path.join(getManagedSkillsDir(), entry.name, "SKILL.md");
      if (!fs.existsSync(filePath)) continue;

      try {
        const raw = fs.readFileSync(filePath, "utf8");
        const fm = parseFrontmatter(raw);
        results.push({
          name: (fm?.name as string | undefined) ?? entry.name,
          description: (fm?.description as string | undefined) ?? "",
          version: (fm?.version as string | undefined) ?? "unknown",
          agentCreated: fm?.agent_created === "true",
          path: filePath,
        });
      } catch {
        // skip unreadable skills
      }
    }
  } catch {
    // skills dir doesn't exist — return empty list
  }

  return results.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Dispatch function called by the agent tool handler.
 * Returns a plain object the LLM can read.
 */
export function skillManage(params: SkillManageParams): SkillManageResult | SkillListEntry[] {
  switch (params.action) {
    case "create":
      return createSkill({
        name: params.name,
        description: params.description,
        content: params.content,
      });
    case "update":
      return updateSkill({ name: params.name, content: params.content });
    case "delete":
      return deleteSkill({ name: params.name });
    case "list":
      return listSkills();
  }
}

/**
 * Tool definition for the skill_manage tool.
 * Agents with learning.enabled: true have access to this tool.
 */
export const skillManageToolDefinition = {
  name: "skill_manage",
  description:
    "Manage reusable SKILL.md files stored in ~/.openclaw/skills/. " +
    "Use create to codify a reusable workflow discovered during a conversation. " +
    "Use update to refine an existing skill. " +
    "Use delete to remove an agent-created skill that is no longer useful (cannot delete user-created skills). " +
    "Use list to see all available managed skills.",
  inputSchema: {
    type: "object" as const,
    properties: {
      action: {
        type: "string",
        enum: ["create", "update", "delete", "list"],
        description: "Operation to perform.",
      },
      name: {
        type: "string",
        description:
          "Skill slug: lowercase letters, digits, hyphens. Required for create/update/delete.",
      },
      description: {
        type: "string",
        description: "One-sentence description shown in the skills catalog. Required for create.",
      },
      content: {
        type: "string",
        description:
          "Full SKILL.md content (Markdown). May include YAML frontmatter. Required for create/update.",
      },
    },
    required: ["action"],
  },
} as const;
