// Live smoke tests for the learning-loop end-to-end flow (Step 4.3.e).
//
// Gating: the entire describe block is skipped unless LIVE=1 or
// OPENCLAW_LIVE_TEST=1 is set in the environment (universal switch via
// isLiveTestEnabled). Per-scenario gating then additionally checks for
// the specific credentials each scenario needs (OAuth profile, env var).
//
// IMPORTANT: this file reads the real ~/.openclaw/agents/main/agent/
// auth-profiles.json to detect available OAuth profiles. The repo's
// shared test setup (test/test-env.ts:installTestEnv) isolates HOME to
// a tmpdir by default — that hides the real auth profiles from
// os.homedir(). To run live, you MUST also set
// OPENCLAW_LIVE_USE_REAL_HOME=1; with both flags, test-env keeps the
// real HOME (test-env.ts:432-434). Example invocation:
//
//   OPENCLAW_LIVE_TEST=1 OPENCLAW_LIVE_USE_REAL_HOME=1 \
//     pnpm test:live src/agents/pi-embedded-runner/skill-review.live.test.ts
//
// Strategy (Option B from the e.1 sketch): we exercise runSkillReview
// directly with a hand-crafted synthetic transcript, NOT a full attempt.ts
// turn loop. Rationale documented in src/agents/pi-embedded-runner/run/
// CLAUDE.md ("use full-runner tests only when the behavior truly requires
// the runner") and the e.1 design discussion. The agent → trigger →
// reviewFn wiring is already covered by 4.3.c learning-review-trigger
// tests with a mocked review fn; what we cover here is the live LLM +
// Hermes prompt + skill_manage + auth resolution path.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getRuntimeConfig } from "../../config/config.js";
import { resolveDefaultAgentDir } from "../agent-scope.js";
import { isLiveTestEnabled } from "../live-test-helpers.js";
import { ensureOpenClawModelsJson } from "../models-config.js";
import { discoverAuthStorage, discoverModels } from "../pi-model-discovery.js";
import { runAsBackgroundReview } from "../skills/skill-provenance.js";
import type { LearningMessage } from "./learning-review.js";
import type { ReviewResult } from "./skill-review-types.js";
import { runSkillReview, type SkillReviewContext } from "./skill-review.js";

// CONFIG_DIR redirect — mirrors the d.x pattern in skill-review.test.ts.
// skill_manage writes to CONFIG_DIR/skills/<name>/SKILL.md; we redirect
// to a fresh tmpDir per test so live smoke runs cannot pollute the
// user's real ~/.openclaw/skills/.
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

const LIVE = isLiveTestEnabled([]);
const describeLive = LIVE ? describe : describe.skip;

// Default 120s per-test. Override matches gateway-models.profiles.live.test.ts.
const LIVE_TIMEOUT_MS = Number(process.env.OPENCLAW_LIVE_TEST_TIMEOUT_MS ?? 120_000);

const REAL_AGENT_DIR = path.join(os.homedir(), ".openclaw", "agents", "main", "agent");

// Scenario C target. ChatGPT-account Codex (OAuth) only serves a fixed
// model set — gpt-5.1-codex-mini is NOT among them and the API rejects it
// with "model is not supported when using Codex with a ChatGPT account".
// ChatGPT-account supported Codex models (from ~/.codex/models_cache.json):
//   gpt-5.4-mini (default, smallest/fastest), gpt-5.4, gpt-5.3-codex,
//   gpt-5.2, codex-auto-review
//   Override via OPENCLAW_LIVE_SKILL_REVIEW_MODEL env var.
const DEFAULT_SKILL_REVIEW_MODEL = "openai-codex/gpt-5.4-mini";
const TARGET_MODEL_REF =
  process.env.OPENCLAW_LIVE_SKILL_REVIEW_MODEL?.trim() || DEFAULT_SKILL_REVIEW_MODEL;

function logProgress(message: string): void {
  process.stderr.write(`[live][skill-review] ${message}\n`);
}

/**
 * Known live blockers — model-side conditions that should skip the test
 * silently rather than fail it. Patterns copied from
 * openai-reasoning-compat.live.test.ts:101-106.
 */
function isKnownLiveBlocker(errorMessage: string): boolean {
  return (
    /not supported when using codex with a chatgpt account/i.test(errorMessage) ||
    /hit your chatgpt usage limit/i.test(errorMessage)
  );
}

/**
 * Returns true when the user has at least one auth profile whose key
 * starts with the given prefix (e.g. "openai-codex:" matches the
 * default Codex OAuth profile). Reads the real auth-profiles.json
 * because review session auth resolution is read-only — see OQ-1.
 *
 * Returns false gracefully when the file is missing or malformed so
 * skipIf reads cleanly without throwing.
 */
function hasProfile(prefix: string): boolean {
  try {
    const file = path.join(REAL_AGENT_DIR, "auth-profiles.json");
    const data = JSON.parse(fs.readFileSync(file, "utf8")) as {
      profiles?: Record<string, unknown>;
    };
    const names = Object.keys(data.profiles ?? {});
    return names.some((n) => n.startsWith(prefix));
  } catch {
    return false;
  }
}

// CODEX_OAUTH must be declared AFTER REAL_AGENT_DIR + hasProfile because
// hasProfile reads REAL_AGENT_DIR via closure. If declared near LIVE
// (before REAL_AGENT_DIR), the TDZ reference inside hasProfile is
// swallowed by the function's try/catch and CODEX_OAUTH silently
// evaluates to false — masking real auth state.
const CODEX_OAUTH = LIVE && hasProfile("openai-codex:");

/**
 * "Ślepy zaułek" transcript — user asks for a file that doesn't exist;
 * the assistant chains three searches before realising and ends the
 * exchange with an explicit lesson ("verify file exists with one stat
 * before chaining recursive finds"). Final assistant message states
 * the takeaway directly so the review model has unambiguous lesson
 * material in pure text (tool blocks are filtered by
 * learning-review-trigger.toLearningMessages in prod — only
 * user/assistant text survives, so simulated tool output is rendered
 * as user-quoted text rather than structured blocks).
 */
function syntheticTranscript(): LearningMessage[] {
  return [
    {
      role: "user",
      content:
        "Find the file PROJECT_HISTORY.md in this repo and tell me the date of its first entry.",
    },
    {
      role: "assistant",
      content:
        "I'll look for PROJECT_HISTORY.md. Starting with `ls PROJECT_HISTORY.md` in the working directory.",
    },
    {
      role: "user",
      content:
        "The command returned: ls: cannot access 'PROJECT_HISTORY.md': No such file or directory",
    },
    {
      role: "assistant",
      content: "Not in cwd. Trying a recursive find: `find . -name PROJECT_HISTORY.md`.",
    },
    {
      role: "user",
      content: "find returned no matches.",
    },
    {
      role: "assistant",
      content:
        "Maybe the casing or extension is off. Trying a broader pattern: `find . -iname '*HISTORY*'`.",
    },
    {
      role: "user",
      content: "Match: ./CHANGELOG.md. No PROJECT_HISTORY.md anywhere in the tree.",
    },
    {
      role: "assistant",
      content:
        "PROJECT_HISTORY.md does not exist in this repository. I should have started by verifying the file exists with one cheap `stat` or `ls` before chaining searches — the three retries were avoidable. Could you confirm the filename, or did you mean CHANGELOG.md?",
    },
    {
      role: "user",
      content: "Right, my mistake — I meant CHANGELOG.md. Skip this one, we're done.",
    },
    {
      role: "assistant",
      content:
        "Acknowledged. Technique for next time: when a user references a specific file by name, run one `stat` or `ls` first to confirm existence; if it isn't there, ask for clarification rather than escalating to broader recursive searches. That would have saved 3 wasted commands here.",
    },
  ];
}

/**
 * Live review runner — Option B (direct runSkillReview, no full
 * attempt.ts loop). agentDir is supplied by the caller so the test
 * body can route through resolveDefaultAgentDir(cfg) and match the
 * registry/auth-storage it built the Model against.
 *
 * The review session uses SessionManager.inMemory() and
 * noTools: "builtin", so the only thing that touches agentDir is the
 * read-side of getApiKeyForModel. OAuth token refresh is allowed to
 * write back through prod auth-storage locking — desired behavior
 * parity with the real learning loop.
 *
 * workspaceDir is a fresh tmpdir per call so any workspace-scoped
 * side effects stay quarantined.
 */
async function runReviewLive(opts: {
  model: Model<Api>;
  agentDir: string;
  authStorage: AuthStorage;
  modelRegistry: ModelRegistry;
  transcript: LearningMessage[];
}): Promise<{ result: ReviewResult; duration: number }> {
  const tmpWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "skill-review-ws-"));
  try {
    const context: SkillReviewContext = {
      agentDir: opts.agentDir,
      workspaceDir: tmpWorkspace,
      config: { learning: { enabled: true } },
      parentModel: opts.model,
      authStorage: opts.authStorage,
      modelRegistry: opts.modelRegistry,
    };
    const start = Date.now();
    const result = await runAsBackgroundReview(() => runSkillReview(opts.transcript, context));
    return { result, duration: Date.now() - start };
  } finally {
    fs.rmSync(tmpWorkspace, { recursive: true, force: true });
  }
}

describeLive("learning loop end-to-end smoke (4.3.e)", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "skill-review-smoke-"));
    fs.mkdirSync(path.join(tmpDir, "skills"), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it.skipIf(!CODEX_OAUTH)(
    "scenario C — OAuth OpenAI Codex (PRIMARY)",
    async () => {
      const cfg = getRuntimeConfig();
      await ensureOpenClawModelsJson(cfg);
      const agentDir = resolveDefaultAgentDir(cfg);
      const authStorage = discoverAuthStorage(agentDir);
      const modelRegistry = discoverModels(authStorage, agentDir);

      const [provider, ...rest] = TARGET_MODEL_REF.split("/");
      const modelId = rest.join("/").trim();
      if (!provider?.trim() || !modelId) {
        throw new Error(
          `Invalid OPENCLAW_LIVE_SKILL_REVIEW_MODEL: ${JSON.stringify(TARGET_MODEL_REF)}`,
        );
      }
      const model = modelRegistry.find(provider, modelId) as Model<Api> | null;
      if (!model) {
        logProgress(`model missing from registry: ${TARGET_MODEL_REF}`);
        return;
      }

      logProgress(`target=${TARGET_MODEL_REF} agentDir=${agentDir}`);

      let liveResult: { result: ReviewResult; duration: number };
      try {
        liveResult = await runReviewLive({
          model,
          agentDir,
          authStorage,
          modelRegistry,
          transcript: syntheticTranscript(),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (isKnownLiveBlocker(msg)) {
          logProgress(`skip (${msg})`);
          return;
        }
        throw err;
      }

      const { result, duration } = liveResult;

      // Always log result + actionsLog to stderr (OQ-E) — surfaces the
      // review's decisions for post-mortem on first runs and on failures.
      process.stderr.write(
        `[live][skill-review] duration=${duration}ms ` +
          `tokensIn=${result.tokensIn} tokensOut=${result.tokensOut} ` +
          `skillsCreated=${result.skillsCreated} ` +
          `skillsUpdated=${result.skillsUpdated} ` +
          `skillsDeleted=${result.skillsDeleted} ` +
          `actionsLog=${JSON.stringify(result.actionsLog ?? [], null, 2)}\n`,
      );

      expect(duration).toBeLessThan(90_000);
      expect(result.tokensIn).toBeGreaterThan(0);
      expect(result.tokensOut).toBeGreaterThan(0);

      const totalMutations = result.skillsCreated + result.skillsUpdated + result.skillsDeleted;
      if (totalMutations === 0 && result.tokensIn > 0) {
        process.stderr.write(
          `[live][skill-review] WARN: model returned end_turn without skill ` +
            `mutations (tokensIn=${result.tokensIn}). Transcript may be too ` +
            `soft for this model. Failing assertion to enforce smoke contract.\n`,
        );
      }
      expect(totalMutations).toBeGreaterThanOrEqual(1);

      const skillsDir = path.join(tmpDir, "skills");
      const skillNames = fs.readdirSync(skillsDir);
      expect(skillNames.length).toBeGreaterThanOrEqual(1);

      const firstSkillName = skillNames[0];
      expect(firstSkillName).toBeDefined();
      const firstSkillFile = path.join(skillsDir, firstSkillName!, "SKILL.md");
      expect(fs.existsSync(firstSkillFile)).toBe(true);

      const content = fs.readFileSync(firstSkillFile, "utf8");
      expect(content).toMatch(/^---\n/);
      expect(content).toMatch(/name:\s*\S+/);
      expect(content).toMatch(/description:\s*\S+/);
      expect(content).toMatch(/agent_created:\s*true/);
    },
    LIVE_TIMEOUT_MS,
  );
});
