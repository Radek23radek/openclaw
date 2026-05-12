import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  resetLearningReviewCountersForTest,
  scheduleLearningReviewIfDue,
} from "./learning-review-trigger.js";
import { type LearningReviewFn } from "./learning-review.js";

// Run scheduled reviews inline so tests can await them deterministically.
vi.mock("../../process/command-queue.js", () => ({
  enqueueCommandInLane: async (_lane: string, fn: () => Promise<void>) => fn(),
}));

afterEach(() => {
  resetLearningReviewCountersForTest();
});

function userMsg(content: string): AgentMessage {
  return { role: "user", content, timestamp: 0 } as AgentMessage;
}
function assistantText(content: string, stopReason: string = "end_turn"): AgentMessage {
  return { role: "assistant", content, timestamp: 0, stopReason } as AgentMessage;
}
function assistantWithToolUse(stopReason: string = "tool_use"): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "tool_use", id: "tu_1", name: "Read", input: {} }],
    timestamp: 0,
    stopReason,
  } as AgentMessage;
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
    expect(reviewFinishedAt).toBeGreaterThanOrEqual(returnedAt + 10);
  });
});
