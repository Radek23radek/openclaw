// Originally from Nous Research Hermes Agent (MIT License).
// See LICENSE-hermes for full attribution.
// Adapted for OpenClaw: single-fork via createAgentSession; G1 (max 3
// skill mutations per review) enforced inside the skill_manage tool
// callback because pi-coding-agent has no native max-iterations option.
//
// Step 4.3.b.2 — wires createAgentSession with sandboxed tools
// (noTools:"builtin" + skill_manage as the only customTool) and a
// 60s Promise.race fail-safe (G5).
// Step 4.3.b.3 — adds G3 (dedup per-name within a review) and G8
// (model spec regex validation).
// Step 4.3.b.4 SKIPPED — pi-coding-agent native OAuth refresh + retry
// (see PORT_PLAN_4_3.md "Discoveries").
// Step 4.3.b.5 — telemetry: tokensIn/tokensOut aggregated from
// session.messages assistant variants, plus a single complete log line.

import { tmpdir } from "node:os";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type Api, type Model } from "@earendil-works/pi-ai";
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getApiKeyForModel } from "../model-auth.js";
import { toToolDefinitions } from "../pi-tool-definition-adapter.js";
import type { AnyAgentTool } from "../tools/common.js";
import { jsonResult } from "../tools/common.js";
import type { LearningMessage } from "./learning-review.js";
import { log } from "./logger.js";
import {
  executeSkillReviewAction,
  SkillReviewToolParamsSchema,
  type SkillReviewToolParams,
} from "./skill-review-tool.js";
import {
  EMPTY_REVIEW_RESULT,
  type ReviewActionLog,
  type ReviewResult,
} from "./skill-review-types.js";

/**
 * Hermes _SKILL_REVIEW_PROMPT — verbatim. Inlined as a template literal so
 * the bundler does not need to resolve a sibling .md asset at runtime.
 */
export const SKILL_REVIEW_PROMPT = `Review the conversation above and update the skill library. Be ACTIVE — most
sessions produce at least one skill update, even if small. A pass that does
nothing is a missed learning opportunity, not a neutral outcome.

Target shape of the library: CLASS-LEVEL skills, each with a rich SKILL.md
and a \`references/\` directory for session-specific detail. Not a long flat
list of narrow one-session-one-skill entries. This shapes HOW you update,
not WHETHER you update.

Signals to look for (any one of these warrants action):
  • User corrected your style, tone, format, legibility, or verbosity.
    Frustration signals like 'stop doing X', 'this is too verbose',
    'don't format like this', 'why are you explaining', 'just give me the
    answer', 'you always do Y and I hate it', or an explicit 'remember this'
    are FIRST-CLASS skill signals, not just memory signals. Update the
    relevant skill(s) to embed the preference so the next session starts
    already knowing.
  • User corrected your workflow, approach, or sequence of steps. Encode
    the correction as a pitfall or explicit step in the skill that governs
    that class of task.
  • Non-trivial technique, fix, workaround, debugging path, or tool-usage
    pattern emerged that a future session would benefit from. Capture it.
  • A skill that got loaded or consulted this session turned out to be
    wrong, missing a step, or outdated. Patch it NOW.

Preference order — prefer the earliest action that fits, but do pick one
when a signal above fired:
  1. UPDATE A CURRENTLY-LOADED SKILL. Look back through the conversation
     for skills the user loaded via /skill-name or you read via skill_view.
     If any of them covers the territory of the new learning, PATCH that
     one first. It is the skill that was in play, so it's the right one
     to extend.
  2. UPDATE AN EXISTING UMBRELLA (via skills_list + skill_view). If no
     loaded skill fits but an existing class-level skill does, patch it.
     Add a subsection, a pitfall, or broaden a trigger.
  3. ADD A SUPPORT FILE under an existing umbrella. Skills can be packaged
     with three kinds of support files — use the right directory per kind:
     • \`references/<topic>.md\` — session-specific detail (error
       transcripts, reproduction recipes, provider quirks) AND condensed
       knowledge banks: quoted research, API docs, external authoritative
       excerpts, or domain notes you found while working on the problem.
       Write it concise and for the value of the task, not as a full
       mirror of upstream docs.
     • \`templates/<name>.<ext>\` — starter files meant to be copied and
       modified (boilerplate configs, scaffolding, a known-good example
       the agent can \`reproduce with modifications\`).
     • \`scripts/<name>.<ext>\` — statically re-runnable actions the skill
       can invoke directly (verification scripts, fixture generators,
       deterministic probes, anything the agent should run rather than
       hand-type each time).
     Add support files via skill_manage action=write_file with file_path
     starting 'references/', 'templates/', or 'scripts/'. The umbrella's
     SKILL.md should gain a one-line pointer to any new support file so
     future agents know it exists.
  4. CREATE A NEW CLASS-LEVEL UMBRELLA SKILL when no existing skill covers
     the class. The name MUST be at the class level. The name MUST NOT be
     a specific PR number, error string, feature codename, library-alone
     name, or 'fix-X / debug-Y / audit-Z-today' session artifact. If the
     proposed name only makes sense for today's task, it's wrong — fall
     back to (1), (2), or (3).

User-preference embedding (important): when the user expressed a
style/format/workflow preference, the update belongs in the SKILL.md body,
not just in memory. Memory captures 'who the user is and what the current
situation and state of your operations are'; skills capture 'how to do
this class of task for this user'. When they complain about how you
handled a task, the skill that governs that task needs to carry the lesson.

If you notice two existing skills that overlap, note it in your reply —
the background curator handles consolidation at scale.

Do NOT capture (these become persistent self-imposed constraints that
bite you later when the environment changes):
  • Environment-dependent failures: missing binaries, fresh-install
    errors, post-migration path mismatches, 'command not found',
    unconfigured credentials, uninstalled packages. The user can fix
    these — they are not durable rules.
  • Negative claims about tools or features ('browser tools do not work',
    'X tool is broken', 'cannot use Y from execute_code'). These harden
    into refusals the agent cites against itself for months after the
    actual problem was fixed.
  • Session-specific transient errors that resolved before the
    conversation ended. If retrying worked, the lesson is the retry
    pattern, not the original failure.
  • One-off task narratives. A user asking 'summarize today's market' or
    'analyze this PR' is not a class of work that warrants a skill.

If a tool failed because of setup state, capture the FIX (install command,
config step, env var to set) under an existing setup or troubleshooting
skill — never 'this tool does not work' as a standalone constraint.

'Nothing to save.' is a real option but should NOT be the default. If the
session ran smoothly with no corrections and produced no new technique,
just say 'Nothing to save.' and stop. Otherwise, act.`;

export type SkillReviewContext = {
  /** Inherited from parent — used for getApiKeyForModel + createAgentSession. */
  agentDir: string;
  /** Inherited from parent — passed to skillManage for workspace-scoped ops. */
  workspaceDir: string;
  /** Parent's resolved OpenClaw config — supplies learning.reviewModel. */
  config: OpenClawConfig;
  /**
   * Parent agent's already-resolved model. Used both as the fallback target
   * for reviewModel="auto" and as the auth precedence anchor.
   */
  parentModel: Model<Api>;
  /** Optional caller-supplied AbortSignal (e.g. process shutdown). */
  signal?: AbortSignal;
};

export type SkillReviewDeps = {
  /** Test seam — overrides the inlined prompt (4.3.d uses this). */
  promptOverride?: string;
  /** Test seam — overrides Date.now (4.3.d uses this for timing assertions). */
  now?: () => number;
  /**
   * Test seam — overrides the createAgentSession factory so tests can inject
   * a fake AgentSession (4.3.d). Production leaves this undefined and the
   * real `createAgentSession` from pi-coding-agent is used.
   */
  createSession?: typeof createAgentSession;
  /**
   * Test seam — overrides the pre-flight auth resolver (G9). Production
   * leaves this undefined and the real `getApiKeyForModel` from model-auth
   * is used. d.5 auth tests inject a rejecting stub here to assert the
   * G9 skip path returns EMPTY_REVIEW_RESULT.
   */
  resolveAuth?: typeof getApiKeyForModel;
};

/** G8: format check for learning.reviewModel — "<provider>/<model_id>". */
const REVIEW_MODEL_SPEC_REGEX = /^[a-z][a-z0-9-]*\/[a-z][a-z0-9.-]*$/;

/**
 * Resolve a learning.reviewModel spec to a concrete Model<Api>.
 *
 * - "auto" (or undefined) → parent's model
 * - "<provider>/<id>" matching G8 regex → fallback to parentModel + warn
 *   (full custom-override support ships in Etap 5 via modelRegistry lookup)
 * - malformed string → fallback to parentModel + warn
 *
 * Always returns a Model<Api> in 4.3 (parentModel is the safe default).
 * Returns null only as a future-proof escape hatch for unrecoverable cases.
 */
export function resolveReviewModel(
  spec: string | undefined,
  parentModel: Model<Api>,
): Model<Api> | null {
  const value = spec?.trim() || "auto";
  if (value === "auto") {
    return parentModel;
  }
  if (!REVIEW_MODEL_SPEC_REGEX.test(value)) {
    log.warn(
      `[skill-review] reviewModel="${value}" invalid format — expected "<provider>/<model>" — falling back to parent's model`,
    );
    return parentModel;
  }
  // Custom override "<provider>/<id>" requires modelRegistry lookup; that
  // ships in a follow-up step (Etap 5 — see RESUME.md). For now any non-"auto"
  // value warns and falls back to the parent's model so the review still runs.
  log.warn(
    `[skill-review] reviewModel="${value}" override not yet supported in 4.3 — falling back to parent's model`,
  );
  return parentModel;
}

/** G1: hard cap on the number of skill mutations a single review may apply. */
const MAX_SKILLS_PER_REVIEW = 3;
/** G5: hard cap on review wall-clock duration. */
const REVIEW_TIMEOUT_MS = 60_000;

function formatMessagesAsPromptText(messages: LearningMessage[], reviewPrompt: string): string {
  const transcript = messages.map((m) => `<${m.role}>\n${m.content}\n</${m.role}>`).join("\n\n");
  return `${transcript}\n\n${reviewPrompt}`;
}

function aggregateReviewResult(
  actionsLog: ReviewActionLog[],
  textOutput: string,
  usage: { tokensIn: number; tokensOut: number },
): ReviewResult {
  let skillsCreated = 0;
  let skillsUpdated = 0;
  let skillsDeleted = 0;
  let skipped = 0;
  for (const entry of actionsLog) {
    switch (entry.result) {
      case "created":
        skillsCreated += 1;
        break;
      case "updated":
        skillsUpdated += 1;
        break;
      case "deleted":
        skillsDeleted += 1;
        break;
      case "skipped":
        skipped += 1;
        break;
    }
  }
  return {
    skillsCreated,
    skillsUpdated,
    skillsDeleted,
    skipped,
    textOutput,
    tokensIn: usage.tokensIn,
    tokensOut: usage.tokensOut,
    actionsLog,
  };
}

/**
 * Sum input/output tokens across every assistant message in the session.
 * Each AssistantMessage from pi-ai carries a `usage: Usage` field; non-
 * assistant variants (user, toolResult, custom) are skipped. Returns zeros
 * when no usage info is available (e.g. timeout before first response).
 */
function aggregateUsage(messages: AgentMessage[]): { tokensIn: number; tokensOut: number } {
  let tokensIn = 0;
  let tokensOut = 0;
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    const usage = (m as { usage?: { input?: number; output?: number } }).usage;
    if (!usage) continue;
    if (typeof usage.input === "number") tokensIn += usage.input;
    if (typeof usage.output === "number") tokensOut += usage.output;
  }
  return { tokensIn, tokensOut };
}

/**
 * Build the stateful skill_manage tool the review fork sees. Wraps the
 * pure executeSkillReviewAction (4.3.a) with closure-shared state so:
 *   - G1 (max 3 mutations per review) is enforced via mutationCount;
 *   - G3 (per-name dedup) is enforced via processedNames Set;
 * pi-coding-agent has no native iteration limit. Skipped tool_uses return
 * a structured result and the model decides whether to stop on its own.
 */
function buildReviewToolWithCap(
  actionsLog: ReviewActionLog[],
  state: { mutationCount: number },
  processedNames: Set<string>,
): AnyAgentTool {
  return {
    name: "skill_manage",
    label: "Skill manager",
    description:
      "Create, update, or delete an entry in the user's skill library. Use sparingly — only durable, class-level lessons belong here. Returns JSON with the outcome.",
    parameters: SkillReviewToolParamsSchema,
    execute: async (_toolCallId, rawParams) => {
      const params = rawParams as SkillReviewToolParams;
      const name = params.name?.trim() ?? "";

      // G3: dedup per-name within a single review. Hermes prompt has the
      // model pick ONE action (create/update/delete) per skill name; a
      // second tool_use on the same name is a contradiction we skip.
      if (name && processedNames.has(name)) {
        const entry: ReviewActionLog = {
          action: params.action ?? "unknown",
          name,
          result: "skipped",
          reason: "duplicate_name_in_review",
        };
        actionsLog.push(entry);
        return jsonResult(entry);
      }

      state.mutationCount += 1;
      if (state.mutationCount > MAX_SKILLS_PER_REVIEW) {
        const entry: ReviewActionLog = {
          action: params.action ?? "unknown",
          name,
          result: "skipped",
          reason: "max_skills_per_review_exceeded",
        };
        actionsLog.push(entry);
        return jsonResult(entry);
      }

      // Reserve the name BEFORE delegating, so even a downstream skip
      // (validation failure inside skillManage) still blocks retries.
      if (name) processedNames.add(name);

      const outcome = executeSkillReviewAction(params);
      actionsLog.push(outcome);
      return jsonResult(outcome);
    },
  };
}

/**
 * Run one post-turn skill-learning review.
 *
 * 4.3.b.2: forks an isolated AgentSession (in-memory SessionManager,
 * tmpdir cwd, noTools:"builtin", skill_manage as the only customTool),
 * lets the model loop tool-use until it stops, and returns the aggregated
 * outcome. G1 capped via the tool callback; G5 via Promise.race timeout.
 * G7: never throws — any failure logs and returns EMPTY_REVIEW_RESULT.
 *
 * Note: pi-coding-agent's AgentSession.prompt() has no AbortSignal in
 * PromptOptions, so the timeout uses Promise.race. The losing prompt
 * call may keep running in the background of an isolated session, but
 * its side effects are confined to the closure-scoped actionsLog.
 */
export async function runSkillReview(
  messages: LearningMessage[],
  context: SkillReviewContext,
  deps?: SkillReviewDeps,
): Promise<ReviewResult> {
  const now = deps?.now ?? Date.now;
  const startedAt = now();
  try {
    const model = resolveReviewModel(context.config.learning?.reviewModel, context.parentModel);
    if (!model) {
      return EMPTY_REVIEW_RESULT;
    }

    // Pre-flight auth (G9). If credentials are missing or unresolvable, skip
    // gracefully — the trigger module advances the cooldown via the empty
    // result it gets back (cooldown wiring lands in 4.3.c).
    try {
      await (deps?.resolveAuth ?? getApiKeyForModel)({
        model,
        cfg: context.config,
        agentDir: context.agentDir,
        workspaceDir: context.workspaceDir,
      });
    } catch (err) {
      log.warn(
        `[skill-review] skip: no auth for review model provider="${model.provider}" reason=${String(err)}`,
      );
      return EMPTY_REVIEW_RESULT;
    }

    const actionsLog: ReviewActionLog[] = [];
    const counterState = { mutationCount: 0 };
    const processedNames = new Set<string>();
    const reviewTool = buildReviewToolWithCap(actionsLog, counterState, processedNames);

    // NOTE: authStorage left to default — resolves to agentDir/auth.json.
    // Parent agent has its own AuthStorage instance on the same file.
    // SAFE for multi-instance access: AuthStorage uses file-level locking
    // (pi-coding-agent dist/core/auth-storage.d.ts:5 —
    //  "Uses file locking to prevent race conditions when multiple pi instances").
    // OAuth refresh is handled internally by pi-coding-agent via
    // refreshOAuthTokenWithLock (auto-refresh on getApiKey() call).
    // Retryable errors (overloaded/rate-limit/5xx) auto-retried with
    // auto_retry_start/auto_retry_end events.
    // Auth errors that ARE NOT retryable propagate as exceptions →
    // caught by G7 outer try/catch in runSkillReview → EMPTY_REVIEW_RESULT.
    const { session } = await (deps?.createSession ?? createAgentSession)({
      cwd: tmpdir(),
      agentDir: context.agentDir,
      model,
      customTools: toToolDefinitions([reviewTool]),
      sessionManager: SessionManager.inMemory(),
      noTools: "builtin",
    });

    const promptText = formatMessagesAsPromptText(
      messages,
      deps?.promptOverride ?? SKILL_REVIEW_PROMPT,
    );

    // G5: Promise.race fail-safe. PromptOptions has no signal field, so we
    // can't propagate context.signal directly into prompt(). The race covers
    // both the wall-clock timeout and the caller's optional cancel signal.
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(
        () => reject(new Error(`review timeout after ${REVIEW_TIMEOUT_MS}ms`)),
        REVIEW_TIMEOUT_MS,
      );
    });
    const cancelPromise = context.signal
      ? new Promise<never>((_, reject) => {
          const onAbort = () => reject(new Error("review aborted by caller"));
          if (context.signal!.aborted) onAbort();
          else context.signal!.addEventListener("abort", onAbort, { once: true });
        })
      : null;

    try {
      const racers: Array<Promise<unknown>> = [session.prompt(promptText), timeoutPromise];
      if (cancelPromise) racers.push(cancelPromise);
      await Promise.race(racers);
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }

    // textOutput (final assistant text, e.g. "Nothing to save.") still
    // pending; would require an event listener on message_end to capture
    // the model's free-form reply. Deferred to Etap 5.
    const usage = aggregateUsage(session.messages);
    const durationMs = now() - startedAt;
    log.info(
      `[skill-review] complete model=${model.id} durationMs=${durationMs} tokensIn=${usage.tokensIn} tokensOut=${usage.tokensOut} actions=${actionsLog.length}`,
    );
    return aggregateReviewResult(actionsLog, "", usage);
  } catch (err) {
    // G7: never let the review crash the caller.
    log.warn(`[skill-review] unexpected failure: ${String(err)}`);
    return EMPTY_REVIEW_RESULT;
  }
}
