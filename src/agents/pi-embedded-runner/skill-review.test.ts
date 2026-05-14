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
import type {
  CreateAgentSessionOptions,
  CreateAgentSessionResult,
  ToolDefinition,
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
