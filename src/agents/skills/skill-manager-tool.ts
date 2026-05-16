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

// Provenance fields are OpenClaw's concern, not the model's: agent_created
// gates auto-curation (security-relevant), created_at is an objective fact.
// They always take our value, overriding anything the model wrote. Every
// other field — including version/platforms — is the skill author's.
const PROVENANCE_FIELDS = new Set(["agent_created", "created_at"]);
const DEFAULT_VERSION = "1.0.0";
const DEFAULT_PLATFORMS = "[linux, macos, windows]";

/**
 * Split content into frontmatter lines + body. A frontmatter block is a
 * `---` line, content, and a closing `---`. If content does not open with a
 * properly closed block, returns fmLines=null and the whole content as body
 * (graceful: an unterminated `---` is treated as plain content, not a crash).
 */
function splitFrontmatter(content: string): { fmLines: string[] | null; body: string } {
  const match = /^---\r?\n(.*?)\r?\n---\r?\n?/s.exec(content);
  if (!match) {
    return { fmLines: null, body: content };
  }
  const inner = match[1];
  return {
    fmLines: inner.length > 0 ? inner.split(/\r?\n/) : [],
    body: content.slice(match[0].length),
  };
}

/**
 * Group frontmatter lines into field blocks. A block is a top-level `key:`
 * line plus any following continuation lines (multi-line YAML values, list
 * items) up to the next top-level key. Lines before the first key are
 * dropped. Keeps original line text so re-emission preserves the model's
 * exact formatting for fields we pass through.
 */
function parseFieldBlocks(fmLines: string[]): Array<{ key: string; lines: string[] }> {
  const blocks: Array<{ key: string; lines: string[] }> = [];
  let current: { key: string; lines: string[] } | null = null;
  for (const line of fmLines) {
    const keyMatch = /^([A-Za-z_][\w-]*):/.exec(line);
    if (keyMatch) {
      current = { key: keyMatch[1], lines: [line] };
      blocks.push(current);
    } else if (current) {
      current.lines.push(line);
    }
  }
  return blocks;
}

/**
 * Compose a final SKILL.md. Deterministic field order:
 *   name, description       — tool args, authoritative (validated)
 *   version, platforms      — content metadata: model's value wins, else default
 *   <other model fields>    — preserved verbatim (category, tags, custom...)
 *   agent_created, created_at — provenance: always ours, override the model
 * The model's body follows after one blank line. The model's own name/
 * description and any provenance fields it wrote are dropped — tool args and
 * our provenance replace them.
 */
function composeSkillFile(params: {
  name: string;
  description: string;
  content: string;
  provenance: { agentCreated: boolean; createdAt: string };
}): string {
  const { fmLines, body } = splitFrontmatter(params.content);
  const blocks = parseFieldBlocks(fmLines ?? []);

  const fields: string[] = [
    `name: ${params.name}`,
    `description: "${params.description.replace(/"/g, '\\"')}"`,
  ];

  const versionBlock = blocks.find((b) => b.key === "version");
  fields.push(...(versionBlock ? versionBlock.lines : [`version: ${DEFAULT_VERSION}`]));
  const platformsBlock = blocks.find((b) => b.key === "platforms");
  fields.push(...(platformsBlock ? platformsBlock.lines : [`platforms: ${DEFAULT_PLATFORMS}`]));

  for (const block of blocks) {
    if (block.key === "name" || block.key === "description") continue;
    if (block.key === "version" || block.key === "platforms") continue;
    if (PROVENANCE_FIELDS.has(block.key)) continue;
    fields.push(...block.lines);
  }

  fields.push(`agent_created: ${params.provenance.agentCreated}`);
  fields.push(`created_at: "${params.provenance.createdAt}"`);

  const bodyText = body.replace(/^\r?\n+/, "");
  return `---\n${fields.join("\n")}\n---\n\n${bodyText}`;
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
  // composeSkillFile merges any model-supplied frontmatter with our
  // provenance fields. Earlier this path used the model's content verbatim
  // when it opened with `---`, which silently dropped agent_created.
  const finalContent = composeSkillFile({
    name: params.name,
    description: params.description,
    content: params.content,
    provenance: { agentCreated, createdAt: new Date().toISOString() },
  });

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

  // Provenance reflects the original creator and is immutable across updates:
  // re-read it from the existing file rather than the current review context.
  // A background-review update of a user-created skill keeps
  // agent_created: false. name/description are likewise the skill's identity
  // and are preserved from the existing file (update only changes the body
  // and any non-provenance metadata the model supplies).
  const existingFm = parseFrontmatter(fs.readFileSync(filePath, "utf8"));
  const agentCreated = existingFm?.agent_created === "true";
  const existingCreatedAt = existingFm?.created_at;
  const createdAt =
    typeof existingCreatedAt === "string" && existingCreatedAt.trim()
      ? existingCreatedAt
      : new Date().toISOString();
  const existingName = existingFm?.name;
  const existingDescription = existingFm?.description;

  const finalContent = composeSkillFile({
    name: typeof existingName === "string" ? existingName : params.name,
    description: typeof existingDescription === "string" ? existingDescription : "",
    content: params.content,
    provenance: { agentCreated, createdAt },
  });
  fs.writeFileSync(filePath, finalContent, "utf8");
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
