import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  recordReviewResult,
  resetLearningReviewCountersForTest,
  scheduleLearningReviewIfDue,
  shouldSkipForCooldown,
} from "./learning-review-trigger.js";
import { type LearningReviewFn } from "./learning-review.js";
import { EMPTY_REVIEW_RESULT, type ReviewResult } from "./skill-review-types.js";

// Run scheduled reviews inline so tests can await them deterministically.
vi.mock("../../process/command-queue.js", () => ({
  enqueueCommandInLane: async (_lane: string, fn: () => Promise<void>) => fn(),
}));

afterEach(() => {
  resetLearningReviewCountersForTest();
});

// Casts use `as unknown as AgentMessage` because pi-coding-agent's runtime
// stopReason values ("end_turn", "tool_use") and minimal message shapes
// don't satisfy pi-ai's stricter AssistantMessage type (which requires
// api/provider/model/usage and a StopReason enum subset). See
// PORT_PLAN_4_3.md "Type discrepancy" for the full discovery.
function userMsg(content: string): AgentMessage {
  return { role: "user", content, timestamp: 0 } as unknown as AgentMessage;
}
function assistantText(content: string, stopReason: string = "end_turn"): AgentMessage {
  return { role: "assistant", content, timestamp: 0, stopReason } as unknown as AgentMessage;
}
function assistantWithToolUse(stopReason: string = "tool_use"): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "tool_use", id: "tu_1", name: "Read", input: {} }],
    timestamp: 0,
    stopReason,
  } as unknown as AgentMessage;
}

function makeReviewResult(overrides: Partial<ReviewResult> = {}): ReviewResult {
  return { ...EMPTY_REVIEW_RESULT, ...overrides };
}

const enabledConfig: OpenClawConfig = { learning: { enabled: true, nudgeInterval: 5 } };

describe("scheduleLearningReviewIfDue — gating", () => {
  it("is a no-op when learning.enabled is undefined", async () => {
    const reviewFn = vi.fn<LearningReviewFn>();
    for (let i = 0; i < 10; i += 1) {
      scheduleLearningReviewIfDue({
        sessionKey: "s1",
        agentId: "main",
        config: {},
        messagesSnapshot: [userMsg("hi"), assistantText("hello")],
        prePromptMessageCount: 0,
        reviewFn,
      });
    }
    await new Promise((r) => setImmediate(r));
    expect(reviewFn).not.toHaveBeenCalled();
  });

  it("is a no-op when learning.enabled is false (counter does not advance)", async () => {
    const reviewFn = vi.fn<LearningReviewFn>();
    // 10 turns with disabled — should not increment counter
    for (let i = 0; i < 10; i += 1) {
      scheduleLearningReviewIfDue({
        sessionKey: "s2",
        agentId: "main",
        config: { learning: { enabled: false, nudgeInterval: 5 } },
        messagesSnapshot: [userMsg("hi"), assistantText("hello")],
        prePromptMessageCount: 0,
        reviewFn,
      });
    }
    // Switch to enabled — should fire on 5th call from now, not immediately
    for (let i = 0; i < 4; i += 1) {
      scheduleLearningReviewIfDue({
        sessionKey: "s2",
        agentId: "main",
        config: enabledConfig,
        messagesSnapshot: [userMsg("hi"), assistantText("hello")],
        prePromptMessageCount: 0,
        reviewFn,
      });
    }
    await new Promise((r) => setImmediate(r));
    expect(reviewFn).not.toHaveBeenCalled();
    scheduleLearningReviewIfDue({
      sessionKey: "s2",
      agentId: "main",
      config: enabledConfig,
      messagesSnapshot: [userMsg("hi"), assistantText("hello")],
      prePromptMessageCount: 0,
      reviewFn,
    });
    await vi.waitFor(() => expect(reviewFn).toHaveBeenCalledTimes(1));
  });
});

describe("scheduleLearningReviewIfDue — interval trigger", () => {
  it("fires exactly every N turns", async () => {
    const reviewFn = vi.fn<LearningReviewFn>();
    for (let i = 1; i <= 12; i += 1) {
      scheduleLearningReviewIfDue({
        sessionKey: "s-int",
        agentId: "main",
        config: enabledConfig,
        // Only assistant text — no tool_use, no end_turn-after-work
        // so natural-break never triggers and only the counter does.
        messagesSnapshot: [userMsg("q"), assistantText("just a question?", "stop")],
        prePromptMessageCount: 0,
        reviewFn,
      });
    }
    await vi.waitFor(() => expect(reviewFn).toHaveBeenCalledTimes(2)); // at 5 and 10
  });

  it("each session has its own counter", async () => {
    const reviewFn = vi.fn<LearningReviewFn>();
    for (let i = 1; i <= 4; i += 1) {
      scheduleLearningReviewIfDue({
        sessionKey: "sA",
        agentId: "main",
        config: enabledConfig,
        messagesSnapshot: [userMsg("q"), assistantText("a", "stop")],
        prePromptMessageCount: 0,
        reviewFn,
      });
      scheduleLearningReviewIfDue({
        sessionKey: "sB",
        agentId: "main",
        config: enabledConfig,
        messagesSnapshot: [userMsg("q"), assistantText("a", "stop")],
        prePromptMessageCount: 0,
        reviewFn,
      });
    }
    await new Promise((r) => setImmediate(r));
    expect(reviewFn).not.toHaveBeenCalled(); // each counter at 4
    scheduleLearningReviewIfDue({
      sessionKey: "sA",
      agentId: "main",
      config: enabledConfig,
      messagesSnapshot: [userMsg("q"), assistantText("a", "stop")],
      prePromptMessageCount: 0,
      reviewFn,
    });
    await vi.waitFor(() => expect(reviewFn).toHaveBeenCalledTimes(1));
  });
});

describe("scheduleLearningReviewIfDue — natural-break trigger", () => {
  it("fires when last assistant ends with end_turn AND earlier assistant had tool_use", async () => {
    const reviewFn = vi.fn<LearningReviewFn>();
    const turn: AgentMessage[] = [
      userMsg("do the thing"),
      assistantWithToolUse("tool_use"),
      // tool result would be here in real session
      assistantText("Done!", "end_turn"),
    ];
    scheduleLearningReviewIfDue({
      sessionKey: "s-nb",
      agentId: "main",
      config: enabledConfig,
      messagesSnapshot: turn,
      prePromptMessageCount: 0,
      reviewFn,
    });
    await vi.waitFor(() => expect(reviewFn).toHaveBeenCalledTimes(1));
  });

  it("does NOT fire when assistant ended end_turn but no tool_use earlier (just clarification)", async () => {
    const reviewFn = vi.fn<LearningReviewFn>();
    const turn: AgentMessage[] = [
      userMsg("?"),
      assistantText("ok, what exactly do you want?", "end_turn"),
    ];
    scheduleLearningReviewIfDue({
      sessionKey: "s-clarify",
      agentId: "main",
      config: enabledConfig,
      messagesSnapshot: turn,
      prePromptMessageCount: 0,
      reviewFn,
    });
    await new Promise((r) => setImmediate(r));
    expect(reviewFn).not.toHaveBeenCalled();
  });

  it("does NOT fire mid-turn (last assistant is a tool_use)", async () => {
    const reviewFn = vi.fn<LearningReviewFn>();
    const turn: AgentMessage[] = [userMsg("go"), assistantWithToolUse("tool_use")];
    scheduleLearningReviewIfDue({
      sessionKey: "s-mid",
      agentId: "main",
      config: enabledConfig,
      messagesSnapshot: turn,
      prePromptMessageCount: 0,
      reviewFn,
    });
    await new Promise((r) => setImmediate(r));
    expect(reviewFn).not.toHaveBeenCalled();
  });
});

describe("scheduleLearningReviewIfDue — async, non-blocking", () => {
  it("returns void synchronously even when reviewFn awaits", async () => {
    let reviewFinishedAt = 0;
    const reviewFn: LearningReviewFn = async () => {
      await new Promise((r) => setTimeout(r, 10));
      reviewFinishedAt = Date.now();
    };
    const turn: AgentMessage[] = [
      userMsg("do"),
      assistantWithToolUse("tool_use"),
      assistantText("done", "end_turn"),
    ];

    const returnedAt = Date.now();
    const returnValue = scheduleLearningReviewIfDue({
      sessionKey: "s-async",
      agentId: "main",
      config: enabledConfig,
      messagesSnapshot: turn,
      prePromptMessageCount: 0,
      reviewFn,
    });

    // Synchronous void return — does not block on the 10ms reviewFn delay
    expect(returnValue).toBeUndefined();
    expect(reviewFinishedAt).toBe(0); // reviewFn has not finished yet

    await vi.waitFor(() => expect(reviewFinishedAt).toBeGreaterThan(0));
    // Allow 1ms slop: Date.now() has 1ms granularity and truncates, so a
    // boundary tick between returnedAt and reviewFinishedAt can shave 1ms
    // off the observed delay even when setTimeout(10) waits its full duration.
    expect(reviewFinishedAt).toBeGreaterThanOrEqual(returnedAt + 9);
  });
});

describe("cooldown — state transitions (G4)", () => {
  it("starts with no cooldown for an unseen session", () => {
    expect(shouldSkipForCooldown("fresh-session", 1)).toBe(false);
    expect(shouldSkipForCooldown("fresh-session", 999)).toBe(false);
  });

  it("does not trip below 3 consecutive empty reviews", () => {
    recordReviewResult("s1", 5, makeReviewResult());
    expect(shouldSkipForCooldown("s1", 6)).toBe(false);
    recordReviewResult("s1", 10, makeReviewResult());
    expect(shouldSkipForCooldown("s1", 11)).toBe(false);
  });

  it("trips on 3rd consecutive empty review, cooldown lasts 10 turns", () => {
    recordReviewResult("s1", 5, makeReviewResult());
    recordReviewResult("s1", 10, makeReviewResult());
    recordReviewResult("s1", 15, makeReviewResult());
    // skipUntilTurnCount = 15 + 10 = 25
    expect(shouldSkipForCooldown("s1", 15)).toBe(true);
    expect(shouldSkipForCooldown("s1", 24)).toBe(true);
    // Passive expiry boundary: turnCount === skipUntilTurnCount is no
    // longer skipped (strict less-than).
    expect(shouldSkipForCooldown("s1", 25)).toBe(false);
    expect(shouldSkipForCooldown("s1", 26)).toBe(false);
  });

  it("active reset mid-streak: non-empty review clears emptyStreak", () => {
    recordReviewResult("s1", 5, makeReviewResult());
    recordReviewResult("s1", 10, makeReviewResult());
    recordReviewResult("s1", 15, makeReviewResult({ skillsCreated: 1 }));
    // Streak cleared by the non-empty. Two more empties must NOT trip.
    recordReviewResult("s1", 20, makeReviewResult());
    recordReviewResult("s1", 25, makeReviewResult());
    expect(shouldSkipForCooldown("s1", 26)).toBe(false);
  });

  it("active reset during cooldown: non-empty review clears it immediately", () => {
    recordReviewResult("s1", 5, makeReviewResult());
    recordReviewResult("s1", 10, makeReviewResult());
    recordReviewResult("s1", 15, makeReviewResult()); // trip → skipUntil = 25
    expect(shouldSkipForCooldown("s1", 20)).toBe(true);
    recordReviewResult("s1", 20, makeReviewResult({ skillsUpdated: 1 }));
    expect(shouldSkipForCooldown("s1", 20)).toBe(false);
    expect(shouldSkipForCooldown("s1", 24)).toBe(false);
  });

  it("passive expiry: cooldown ends without an explicit reset call", () => {
    recordReviewResult("s1", 5, makeReviewResult());
    recordReviewResult("s1", 10, makeReviewResult());
    recordReviewResult("s1", 15, makeReviewResult()); // trip → skipUntil = 25
    expect(shouldSkipForCooldown("s1", 24)).toBe(true);
    expect(shouldSkipForCooldown("s1", 25)).toBe(false);
    // emptyStreak was reset to 0 at trip time, so a fresh empty after
    // expiry starts a NEW streak from 1, not re-trips immediately.
    recordReviewResult("s1", 25, makeReviewResult());
    expect(shouldSkipForCooldown("s1", 26)).toBe(false);
  });

  it("recognises non-empty via skillsDeleted (delete-only counts as work)", () => {
    recordReviewResult("s1", 5, makeReviewResult());
    recordReviewResult("s1", 10, makeReviewResult());
    recordReviewResult("s1", 15, makeReviewResult({ skillsDeleted: 1 }));
    recordReviewResult("s1", 20, makeReviewResult());
    recordReviewResult("s1", 25, makeReviewResult());
    expect(shouldSkipForCooldown("s1", 26)).toBe(false);
  });

  it("counts `skipped` (rejected by guardrails) as empty — still increments streak", () => {
    // isEmptyReview ignores `skipped`; only created+updated+deleted matter.
    // Three reviews where the model called the tool but every call was
    // skipped by a guardrail still count as 3 empties → trip.
    recordReviewResult("s1", 5, makeReviewResult({ skipped: 3 }));
    recordReviewResult("s1", 10, makeReviewResult({ skipped: 3 }));
    recordReviewResult("s1", 15, makeReviewResult({ skipped: 3 }));
    expect(shouldSkipForCooldown("s1", 16)).toBe(true);
  });

  it("sessions are independent", () => {
    recordReviewResult("s1", 5, makeReviewResult());
    recordReviewResult("s1", 10, makeReviewResult());
    recordReviewResult("s1", 15, makeReviewResult()); // s1 trips
    expect(shouldSkipForCooldown("s1", 20)).toBe(true);
    expect(shouldSkipForCooldown("s2", 20)).toBe(false);
  });
});
