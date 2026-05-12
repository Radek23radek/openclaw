// Portions derived from Hermes Agent (MIT) - NousResearch
// https://github.com/NousResearch/hermes-agent
//
// Tool definition for the skill-learning review fork.
//
// Differences from src/agents/skills/skill-manager-tool.ts (Module 3):
//   - Exposes ONLY 3 actions: create, update, delete (no `list` — the review
//     gets a pre-injected snapshot of existing skills in its system prompt,
//     so it never needs to query the catalog at runtime).
//   - `rationale` field — model explains WHY in one line; logged for audits,
//     not persisted in SKILL.md.
//   - executeSkillReviewAction returns a structured ReviewActionLog so the
//     review aggregator can build a ReviewResult without re-parsing strings.
//
// Used by runSkillReview (Step 4.3.b) as a `customTool` passed to
// createAgentSession. The review agent fork sees this as the only skill tool;
// the user-facing skill_manage with the full 4-action surface lives elsewhere.

import { Type } from "typebox";
import { stringEnum } from "../schema/typebox.js";
import { skillManage } from "../skills/skill-manager-tool.js";
import type { AnyAgentTool } from "../tools/common.js";
import { jsonResult } from "../tools/common.js";
import type { ReviewActionLog } from "./skill-review-types.js";

/** Review tool exposes only the 3 mutating actions, never `list`. */
export const REVIEW_ALLOWED_ACTIONS = ["create", "update", "delete"] as const;
export type ReviewAllowedAction = (typeof REVIEW_ALLOWED_ACTIONS)[number];

export const SkillReviewToolParamsSchema = Type.Object({
  action: stringEnum(REVIEW_ALLOWED_ACTIONS, {
    description:
      "One of: create (new skill), update (full content rewrite), delete (agent-created only).",
  }),
  name: Type.String({
    description: "Skill slug: lowercase letters, digits, hyphens. e.g. 'kubernetes-deployments'.",
  }),
  description: Type.Optional(
    Type.String({
      description: "Required for create. One sentence shown in the skills catalog.",
    }),
  ),
  content: Type.Optional(
    Type.String({
      description:
        "Required for create and update. Full SKILL.md content (Markdown). May start with YAML frontmatter.",
    }),
  ),
  rationale: Type.Optional(
    Type.String({
      description: "One-line WHY for this change (for audit logs; not persisted to disk).",
    }),
  ),
});

export type SkillReviewToolParams = {
  action: ReviewAllowedAction;
  name: string;
  description?: string;
  content?: string;
  rationale?: string;
};

/**
 * Execute one skill_manage call from inside a review. Returns a structured
 * outcome the aggregator turns into ReviewResult counters.
 *
 * Pre-validates required fields per action before delegating to skillManage
 * (Module 3). On any failure — validation, duplicate, content cap, user-owned
 * skill on delete — returns { result: "skipped", reason } instead of throwing.
 * The review must never crash a turn.
 */
export function executeSkillReviewAction(params: SkillReviewToolParams): ReviewActionLog {
  const name = params.name?.trim();
  if (!name) {
    return {
      action: params.action,
      name: params.name ?? "",
      result: "skipped",
      reason: "name is required",
    };
  }

  switch (params.action) {
    case "create": {
      if (!params.description?.trim()) {
        return { action: "create", name, result: "skipped", reason: "description is required" };
      }
      if (!params.content?.trim()) {
        return { action: "create", name, result: "skipped", reason: "content is required" };
      }
      const r = skillManage({
        action: "create",
        name,
        description: params.description,
        content: params.content,
      });
      if ("ok" in r && r.ok) return { action: "create", name, result: "created" };
      const reason = "ok" in r ? r.error : "skillManage returned unexpected shape";
      return { action: "create", name, result: "skipped", reason };
    }
    case "update": {
      if (!params.content?.trim()) {
        return { action: "update", name, result: "skipped", reason: "content is required" };
      }
      const r = skillManage({ action: "update", name, content: params.content });
      if ("ok" in r && r.ok) return { action: "update", name, result: "updated" };
      const reason = "ok" in r ? r.error : "skillManage returned unexpected shape";
      return { action: "update", name, result: "skipped", reason };
    }
    case "delete": {
      const r = skillManage({ action: "delete", name });
      if ("ok" in r && r.ok) return { action: "delete", name, result: "deleted" };
      const reason = "ok" in r ? r.error : "skillManage returned unexpected shape";
      return { action: "delete", name, result: "skipped", reason };
    }
  }
}

/**
 * Build a pi-coding-agent AnyAgentTool the review fork can call. Each
 * tool_use block from the model invokes executeSkillReviewAction once and
 * returns its JSON outcome to the model as the tool result.
 */
export function createSkillReviewTool(): AnyAgentTool {
  return {
    name: "skill_manage",
    label: "Skill manager",
    description:
      "Create, update, or delete an entry in the user's skill library. Use sparingly — only durable, class-level lessons belong here. Returns JSON with the outcome.",
    parameters: SkillReviewToolParamsSchema,
    execute: async (_toolCallId, rawParams) => {
      const params = rawParams as SkillReviewToolParams;
      const outcome = executeSkillReviewAction(params);
      return jsonResult(outcome);
    },
  };
}
