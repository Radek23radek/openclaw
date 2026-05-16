// End-to-end tests for runSkillReview using SkillReviewDeps test seams.
// No vi.mock at module level except CONFIG_DIR redirect (precedent from
// skill-review-tool.test.ts) — auth and session creation are injected
// per-test via deps. Mirrors learning-review.ts:54's runAsBackgroundReview
// wrap so skill_manage sees the same context as production.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  type AuthStorage,
  type CreateAgentSessionOptions,
  type CreateAgentSessionResult,
  type ModelRegistry,
  SessionManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAsBackgroundReview } from "../skills/skill-provenance.js";
import type { LearningMessage } from "./learning-review.js";
import { isEmptyReview } from "./skill-review-types.js";
import { runSkillReview, type SkillReviewContext } from "./skill-review.js";

let tmpDir: string;

// CONFIG_DIR redirect — skillManage writes under CONFIG_DIR/skills/<name>/SKILL.md.
// Same pattern used in skill-review-tool.test.ts (4.3.a). tmpDir is rotated
// per test in beforeEach so file writes do not bleed across cases.
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "skill-review-test-"));
  fs.mkdirSync(path.join(tmpDir, "skills"), { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ===========================================================================
// Fixture helpers
// ===========================================================================

/**
 * Fake AgentSession. `prompt()` replays opts.toolCalls against the
 * ToolDefinitions captured via `captureTools()`. `session.messages` is
 * pre-populated with assistant stubs carrying opts.usage so aggregateUsage
 * (skill-review.ts:251) can sum them — F.5 contract.
 *
 * The `as unknown as AgentMessage` cast mirrors the pi-coding-agent runtime
 * vs pi-ai typed-enum asymmetry documented in PORT_PLAN_4_3.md "Type
 * discrepancy" (c.3.a discovery).
 */
function makeMockSession(
  opts: {
    toolCalls?: Array<{ tool: string; input: unknown }>;
    usage?: Array<{ input: number; output: number }>;
  } = {},
): {
  captureTools: (tools: ToolDefinition[]) => void;
  session: { prompt: (text: string) => Promise<void>; messages: AgentMessage[] };
} {
  let registeredTools: ToolDefinition[] = [];
  const messages: AgentMessage[] = (opts.usage ?? []).map(
    (u) =>
      ({
        role: "assistant",
        content: [],
        timestamp: 0,
        stopReason: "end_turn",
        usage: u,
      }) as unknown as AgentMessage,
  );
  return {
    captureTools: (tools) => {
      registeredTools = tools;
    },
    session: {
      prompt: async (_text: string) => {
        for (const call of opts.toolCalls ?? []) {
          const t = registeredTools.find((x) => x.name === call.tool);
          if (t) await t.execute("test-id", call.input);
        }
      },
      messages,
    },
  };
}

/**
 * Mock factory for SkillReviewDeps.createSession. Invokes
 * `mock.captureTools(opts.customTools ?? [])` BEFORE returning so the
 * fake session can see the stateful skill_manage tool wrapper that
 * runSkillReview builds (buildReviewToolWithCap — closure-shared G1
 * counter + G3 dedup set).
 */
function makeMockCreateSession(
  mock: ReturnType<typeof makeMockSession>,
): (opts: CreateAgentSessionOptions) => Promise<CreateAgentSessionResult> {
  return async (opts) => {
    mock.captureTools((opts.customTools ?? []) as unknown as ToolDefinition[]);
    return {
      session: mock.session as unknown as CreateAgentSessionResult["session"],
      extensionsResult: {} as unknown as CreateAgentSessionResult["extensionsResult"],
    };
  };
}

function makeReviewContext(overrides?: Partial<SkillReviewContext>): SkillReviewContext {
  const parentModel = {
    id: "claude-sonnet-4-6",
    provider: "anthropic",
    api: "anthropic",
  } as unknown as Model<Api>;
  return {
    agentDir: tmpDir,
    workspaceDir: tmpDir,
    config: { learning: { enabled: true } },
    parentModel,
    // Stubs — these tests inject a mock createSession, so the real
    // createAgentSession (the only consumer of authStorage/modelRegistry)
    // is never reached. The d.4 sandbox test asserts they are passed
    // through by identity. Live wiring is exercised by skill-review.live.test.ts.
    authStorage: {} as AuthStorage,
    modelRegistry: {} as ModelRegistry,
    ...overrides,
  };
}

function makeMockMessages(count: number = 1): LearningMessage[] {
  const msgs: LearningMessage[] = [];
  for (let i = 0; i < count; i += 1) {
    msgs.push({ role: "user", content: `user message ${i}` });
    msgs.push({ role: "assistant", content: `assistant reply ${i}` });
  }
  return msgs;
}

/** Always-resolving auth stub for happy-path tests; d.5 overrides per test. */
const resolveAuthOk = async () => "test-api-key";

// ===========================================================================
// Happy-path tests (4.3.d.2)
// ===========================================================================

describe("runSkillReview — happy path (4.3.d.2)", () => {
  it("returns EMPTY_REVIEW_RESULT when model emits end_turn without tool calls", async () => {
    const mock = makeMockSession({ toolCalls: [], usage: [{ input: 100, output: 25 }] });

    const result = await runSkillReview(makeMockMessages(), makeReviewContext(), {
      createSession: makeMockCreateSession(mock),
      resolveAuth: resolveAuthOk,
    });

    expect(isEmptyReview(result)).toBe(true);
    expect(result.skillsCreated).toBe(0);
    expect(result.skillsUpdated).toBe(0);
    expect(result.skillsDeleted).toBe(0);
    expect(result.tokensIn).toBe(100);
    expect(result.tokensOut).toBe(25);
  });

  it("creates skill when model invokes skill_manage create", async () => {
    const mock = makeMockSession({
      toolCalls: [
        {
          tool: "skill_manage",
          input: {
            action: "create",
            name: "test-skill",
            description: "A test skill for d.2",
            content: "# Test\n\nBody content.",
          },
        },
      ],
      usage: [{ input: 200, output: 50 }],
    });

    const result = await runAsBackgroundReview(() =>
      runSkillReview(makeMockMessages(), makeReviewContext(), {
        createSession: makeMockCreateSession(mock),
        resolveAuth: resolveAuthOk,
      }),
    );

    expect(result.skillsCreated).toBe(1);
    expect(result.skillsUpdated).toBe(0);
    expect(isEmptyReview(result)).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, "skills", "test-skill", "SKILL.md"))).toBe(true);
  });

  it("updates existing skill when model invokes skill_manage update", async () => {
    // Pre-seed an existing skill on disk so update has a target.
    const skillDir = path.join(tmpDir, "skills", "foo");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, "SKILL.md"),
      "---\nname: foo\ndescription: original\nagent_created: true\n---\n\nOriginal body.",
    );

    const mock = makeMockSession({
      toolCalls: [
        {
          tool: "skill_manage",
          input: {
            action: "update",
            name: "foo",
            content: "# foo\n\nUpdated body.",
          },
        },
      ],
    });

    const result = await runAsBackgroundReview(() =>
      runSkillReview(makeMockMessages(), makeReviewContext(), {
        createSession: makeMockCreateSession(mock),
        resolveAuth: resolveAuthOk,
      }),
    );

    expect(result.skillsUpdated).toBe(1);
    expect(result.skillsCreated).toBe(0);
    const updatedContent = fs.readFileSync(path.join(skillDir, "SKILL.md"), "utf8");
    expect(updatedContent).toContain("Updated body");
  });
});

// ===========================================================================
// Guardrail + defensive tests (4.3.d.3)
// ===========================================================================

describe("runSkillReview — guardrails + defensive (4.3.d.3)", () => {
  it("G1: caps skill mutations at 3 per review; 4th create is skipped", async () => {
    const calls = [1, 2, 3, 4].map((i) => ({
      tool: "skill_manage",
      input: {
        action: "create",
        name: `cap-${i}`,
        description: `skill ${i}`,
        content: `# Skill ${i}\n\nBody.`,
      },
    }));
    const mock = makeMockSession({ toolCalls: calls });

    const result = await runAsBackgroundReview(() =>
      runSkillReview(makeMockMessages(), makeReviewContext(), {
        createSession: makeMockCreateSession(mock),
        resolveAuth: resolveAuthOk,
      }),
    );

    expect(result.skillsCreated).toBe(3);
    expect(result.skipped).toBe(1);
    const skippedEntry = result.actionsLog?.find((e) => e.result === "skipped");
    expect(skippedEntry?.reason).toBe("max_skills_per_review_exceeded");
  });

  it("G3: dedup by name — second tool_use with same name is skipped", async () => {
    const mock = makeMockSession({
      toolCalls: [
        {
          tool: "skill_manage",
          input: {
            action: "create",
            name: "dup",
            description: "first",
            content: "# First",
          },
        },
        {
          tool: "skill_manage",
          input: {
            action: "create",
            name: "dup",
            description: "second",
            content: "# Second",
          },
        },
      ],
    });

    const result = await runAsBackgroundReview(() =>
      runSkillReview(makeMockMessages(), makeReviewContext(), {
        createSession: makeMockCreateSession(mock),
        resolveAuth: resolveAuthOk,
      }),
    );

    expect(result.skillsCreated).toBe(1);
    expect(result.skipped).toBe(1);
    const skippedEntry = result.actionsLog?.find((e) => e.result === "skipped");
    expect(skippedEntry?.reason).toBe("duplicate_name_in_review");
  });

  it("G2: skips create when content exceeds 32KB byte limit", async () => {
    // MAX_SKILL_CONTENT_BYTES = 32_768 in skill-manager-tool.ts.
    const oversized = "x".repeat(33_000);
    const mock = makeMockSession({
      toolCalls: [
        {
          tool: "skill_manage",
          input: {
            action: "create",
            name: "huge",
            description: "test G2",
            content: oversized,
          },
        },
      ],
    });

    const result = await runAsBackgroundReview(() =>
      runSkillReview(makeMockMessages(), makeReviewContext(), {
        createSession: makeMockCreateSession(mock),
        resolveAuth: resolveAuthOk,
      }),
    );

    expect(result.skillsCreated).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.actionsLog?.[0]?.reason).toContain("exceeds limit");
  });

  it("defensive: skips create with empty name", async () => {
    const mock = makeMockSession({
      toolCalls: [
        {
          tool: "skill_manage",
          input: {
            action: "create",
            name: "",
            description: "missing-name",
            content: "# Body",
          },
        },
      ],
    });

    const result = await runAsBackgroundReview(() =>
      runSkillReview(makeMockMessages(), makeReviewContext(), {
        createSession: makeMockCreateSession(mock),
        resolveAuth: resolveAuthOk,
      }),
    );

    expect(result.skillsCreated).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.actionsLog?.[0]?.reason).toBe("name is required");
  });

  it("defensive: skips create when content field is missing", async () => {
    const mock = makeMockSession({
      toolCalls: [
        {
          tool: "skill_manage",
          input: {
            action: "create",
            name: "no-content",
            description: "missing content field",
            // content omitted on purpose
          },
        },
      ],
    });

    const result = await runAsBackgroundReview(() =>
      runSkillReview(makeMockMessages(), makeReviewContext(), {
        createSession: makeMockCreateSession(mock),
        resolveAuth: resolveAuthOk,
      }),
    );

    expect(result.skillsCreated).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.actionsLog?.[0]?.reason).toBe("content is required");
  });

  it("G7: returns EMPTY_REVIEW_RESULT when createSession rejects (does not throw)", async () => {
    const failingCreateSession = (async () => {
      throw new Error("simulated session creation failure");
    }) as unknown as typeof import("@earendil-works/pi-coding-agent").createAgentSession;

    const result = await runSkillReview(makeMockMessages(), makeReviewContext(), {
      createSession: failingCreateSession,
      resolveAuth: resolveAuthOk,
    });

    expect(isEmptyReview(result)).toBe(true);
    expect(result.skillsCreated).toBe(0);
    expect(result.actionsLog).toBeUndefined();
  });

  // G5 timeout test — DEFERRED to 4.3.e.
  // Attempted: vi.useFakeTimers + vi.advanceTimersByTimeAsync(61_000) with a
  // pending session.prompt() Promise. Both never-resolve and setTimeout-based
  // variants hang under fake timers — the interaction between Promise.race,
  // the outer await, and vitest's microtask draining didn't release.
  // Hookable alternatives that would require new prod seams (e.g., a
  // timeoutMs override in SkillReviewDeps, or an injectable setTimeout)
  // are out of scope for d.3. Real-time wait (60s real) is wasteful.
  // 4.3.e end-to-end with real LLM exercises the timeout naturally.
  it.skip("G5: returns EMPTY_REVIEW_RESULT when prompt exceeds 60s timeout (deferred to 4.3.e)", () => {});
});

// ===========================================================================
// Sandbox configuration assertions (4.3.d.4)
// ===========================================================================
// These inspect the options object passed to createAgentSession. Behavioral
// enforcement (e.g. that builtin tools really are blocked when noTools:
// "builtin", or that an in-memory session really writes nothing to disk)
// belongs to 4.3.e end-to-end against the real pi-coding-agent runtime.

describe("runSkillReview — sandbox configuration (4.3.d.4)", () => {
  it("configures pi-coding-agent with noTools: builtin", async () => {
    const mock = makeMockSession({ toolCalls: [] });
    const createSession = vi.fn(makeMockCreateSession(mock));

    await runSkillReview(makeMockMessages(), makeReviewContext(), {
      createSession,
      resolveAuth: resolveAuthOk,
    });

    expect(createSession).toHaveBeenCalledTimes(1);
    const opts = createSession.mock.calls[0]?.[0] as CreateAgentSessionOptions;
    expect(opts.noTools).toBe("builtin");
  });

  it("passes exactly one customTool named skill_manage", async () => {
    const mock = makeMockSession({ toolCalls: [] });
    const createSession = vi.fn(makeMockCreateSession(mock));

    await runSkillReview(makeMockMessages(), makeReviewContext(), {
      createSession,
      resolveAuth: resolveAuthOk,
    });

    const opts = createSession.mock.calls[0]?.[0] as CreateAgentSessionOptions;
    expect(opts.customTools).toHaveLength(1);
    expect(opts.customTools?.[0]?.name).toBe("skill_manage");
  });

  it("uses non-persistent SessionManager for review session", async () => {
    // Kombo: instanceof guards against duck-typed fakes; isPersisted() is the
    // public 1:1 marker for inMemory() vs. create()/open()/continueRecent()/
    // forkFrom() (all of which set persist=true). See session-manager.js:1003.
    const mock = makeMockSession({ toolCalls: [] });
    const createSession = vi.fn(makeMockCreateSession(mock));

    await runSkillReview(makeMockMessages(), makeReviewContext(), {
      createSession,
      resolveAuth: resolveAuthOk,
    });

    const opts = createSession.mock.calls[0]?.[0] as CreateAgentSessionOptions;
    expect(opts.sessionManager).toBeInstanceOf(SessionManager);
    expect(opts.sessionManager?.isPersisted()).toBe(false);
  });

  it("inherits parent authStorage and modelRegistry into the session", async () => {
    // Auth bridge: the review fork must reuse the parent's live AuthStorage
    // (carrying the runtime API key) and ModelRegistry. Without passthrough,
    // pi-coding-agent falls back to the empty agentDir/auth.json and the
    // session fails with "No API key found".
    const mock = makeMockSession({ toolCalls: [] });
    const createSession = vi.fn(makeMockCreateSession(mock));
    const context = makeReviewContext();

    await runSkillReview(makeMockMessages(), context, {
      createSession,
      resolveAuth: resolveAuthOk,
    });

    const opts = createSession.mock.calls[0]?.[0] as CreateAgentSessionOptions;
    expect(opts.authStorage).toBe(context.authStorage);
    expect(opts.modelRegistry).toBe(context.modelRegistry);
  });
});

// ===========================================================================
// Auth + model resolution (4.3.d.5)
// ===========================================================================
// Auth check (G9) runs before createSession; model resolution (G8 + "auto")
// runs in resolveReviewModel and feeds the model option. Behavioral
// assertions only — log.warn output is a side effect we deliberately do
// not capture (consistent with d.3 discipline).

describe("runSkillReview — auth + model resolution (4.3.d.5)", () => {
  it("G9: returns EMPTY_REVIEW_RESULT when resolveAuth rejects (createSession never called)", async () => {
    const mock = makeMockSession({ toolCalls: [] });
    const createSession = vi.fn(makeMockCreateSession(mock));
    // Manual cast mirrors d.3 G7's failingCreateSession pattern — avoids
    // taking a dependency on vi.fn<T>() generic syntax variance across
    // Vitest versions while still typechecking under tsgo.
    const failingAuth = (async () => {
      throw new Error("no api key for provider anthropic");
    }) as unknown as typeof import("../model-auth.js").getApiKeyForModel;

    const result = await runSkillReview(makeMockMessages(), makeReviewContext(), {
      createSession,
      resolveAuth: failingAuth,
    });

    expect(isEmptyReview(result)).toBe(true);
    expect(createSession).not.toHaveBeenCalled();
  });

  it("G8: falls back to parentModel when reviewModel format is invalid", async () => {
    const mock = makeMockSession({ toolCalls: [] });
    const createSession = vi.fn(makeMockCreateSession(mock));
    const context = makeReviewContext({
      config: { learning: { enabled: true, reviewModel: "not-a-valid-spec" } },
    });

    await runSkillReview(makeMockMessages(), context, {
      createSession,
      resolveAuth: resolveAuthOk,
    });

    expect(createSession).toHaveBeenCalledTimes(1);
    const opts = createSession.mock.calls[0]?.[0] as CreateAgentSessionOptions;
    expect(opts.model).toBe(context.parentModel);
  });

  it('resolves reviewModel "auto" to parentModel', async () => {
    const mock = makeMockSession({ toolCalls: [] });
    const createSession = vi.fn(makeMockCreateSession(mock));
    const context = makeReviewContext({
      config: { learning: { enabled: true, reviewModel: "auto" } },
    });

    await runSkillReview(makeMockMessages(), context, {
      createSession,
      resolveAuth: resolveAuthOk,
    });

    const opts = createSession.mock.calls[0]?.[0] as CreateAgentSessionOptions;
    expect(opts.model).toBe(context.parentModel);
  });
});
