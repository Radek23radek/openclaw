// Live smoke tests for the learning-loop end-to-end flow (Step 4.3.e).
//
// Gating: the entire describe block is skipped unless LIVE=1 or
// OPENCLAW_LIVE_TEST=1 is set in the environment (universal switch via
// isLiveTestEnabled). Per-scenario gating then additionally checks for
// the specific credentials each scenario needs (OAuth profile, env var).
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
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import { isLiveTestEnabled } from "../live-test-helpers.js";
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
const CODEX_OAUTH = LIVE && hasProfile("openai-codex:");
const describeLive = LIVE ? describe : describe.skip;

// Default 120s per-test. Override matches gateway-models.profiles.live.test.ts.
const LIVE_TIMEOUT_MS = Number(process.env.OPENCLAW_LIVE_TEST_TIMEOUT_MS ?? 120_000);

const REAL_AGENT_DIR = path.join(os.homedir(), ".openclaw", "agents", "main", "agent");

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

/**
 * Placeholder transcript — full "ślepy zaułek" content lands in e.2
 * where it can be tuned against the actual primary scenario (Codex).
 * Kept here only so runReviewLive typechecks and runs without crashing
 * in a hypothetical e.1-only invocation.
 */
function syntheticTranscript(): LearningMessage[] {
  return [
    { role: "user", content: "placeholder — full transcript wired in 4.3.e.2" },
    { role: "assistant", content: "placeholder" },
  ];
}

/**
 * Live review runner — Option B (direct runSkillReview, no full
 * attempt.ts loop). Used by every scenario in this file.
 *
 * agentDir points at REAL_AGENT_DIR (OQ-1 decision): the review session
 * uses SessionManager.inMemory() and noTools: "builtin", so the only
 * thing that touches agentDir is the read-side of getApiKeyForModel.
 * OAuth token refresh is allowed to write back through prod auth-storage
 * locking — desired behavior parity with the real learning loop.
 *
 * workspaceDir is a fresh tmpdir per call so that any workspace-scoped
 * side effects stay quarantined.
 */
async function runReviewLive(opts: {
  model: Model<Api>;
}): Promise<{ result: ReviewResult; duration: number }> {
  const tmpWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "skill-review-ws-"));
  try {
    const context: SkillReviewContext = {
      agentDir: REAL_AGENT_DIR,
      workspaceDir: tmpWorkspace,
      config: { learning: { enabled: true } },
      parentModel: opts.model,
    };
    const start = Date.now();
    const result = await runAsBackgroundReview(() =>
      runSkillReview(syntheticTranscript(), context),
    );
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

  // Body lands in 4.3.e.2: build a Codex Model<Api>, runReviewLive with the
  // full ślepy-zaułek transcript, assert skills/ has >= 1 SKILL.md with
  // valid frontmatter, tokensIn > 0, duration < 90s.
  it.todo(`scenario C — OAuth OpenAI Codex (PRIMARY) [codex_oauth=${CODEX_OAUTH}]`);

  // Suppress unused-symbol warnings for helpers exercised only by e.2/e.4.
  void runReviewLive;
  void LIVE_TIMEOUT_MS;
});
