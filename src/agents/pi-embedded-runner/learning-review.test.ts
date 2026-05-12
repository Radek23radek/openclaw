import { describe, expect, it, vi } from "vitest";
import { isBackgroundReview } from "../skills/skill-provenance.js";
import {
  scheduleLearningReview,
  type LearningMessage,
  type LearningReviewFn,
} from "./learning-review.js";

// Use real enqueueCommandInLane (runs inline in tests with no process/lane overhead)
vi.mock("../../process/command-queue.js", () => ({
  enqueueCommandInLane: async (_lane: string, fn: () => Promise<void>) => fn(),
}));

const baseMessages: LearningMessage[] = [
  { role: "user", content: "How do I deploy to k8s?" },
  { role: "assistant", content: "Use kubectl apply -f deployment.yaml" },
];

describe("scheduleLearningReview — gating", () => {
  it("does nothing when learning.enabled is undefined", async () => {
    const reviewFn = vi.fn<LearningReviewFn>();
    scheduleLearningReview({
      sessionKey: "sess-1",
      messages: baseMessages,
      config: undefined,
      reviewFn,
    });
    expect(reviewFn).not.toHaveBeenCalled();
  });

  it("does nothing when learning.enabled is false", async () => {
    const reviewFn = vi.fn<LearningReviewFn>();
    scheduleLearningReview({
      sessionKey: "sess-1",
      messages: baseMessages,
      config: { enabled: false },
      reviewFn,
    });
    expect(reviewFn).not.toHaveBeenCalled();
  });

  it("does nothing when not enough assistant messages", async () => {
    const reviewFn = vi.fn<LearningReviewFn>();
    scheduleLearningReview({
      sessionKey: "sess-1",
      messages: [{ role: "user", content: "hello" }],
      config: { enabled: true, minAssistantMessages: 1 },
      reviewFn,
    });
    expect(reviewFn).not.toHaveBeenCalled();
  });

  it("fires when learning.enabled is true and has enough messages", async () => {
    const reviewFn = vi.fn<LearningReviewFn>();
    scheduleLearningReview({
      sessionKey: "sess-1",
      messages: baseMessages,
      config: { enabled: true },
      reviewFn,
    });
    await vi.waitFor(() => expect(reviewFn).toHaveBeenCalledOnce());
  });
});

describe("scheduleLearningReview — background_review context", () => {
  it("reviewFn runs inside runAsBackgroundReview context", async () => {
    let capturedOrigin = false;
    const reviewFn: LearningReviewFn = async () => {
      capturedOrigin = isBackgroundReview();
    };
    scheduleLearningReview({
      sessionKey: "sess-2",
      messages: baseMessages,
      config: { enabled: true },
      reviewFn,
    });
    await vi.waitFor(() => expect(capturedOrigin).toBe(true));
  });
});

describe("scheduleLearningReview — message trimming", () => {
  it("trims to maxReviewMessages most-recent messages", async () => {
    const many: LearningMessage[] = Array.from({ length: 20 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `msg-${i}`,
    }));

    let received: LearningMessage[] = [];
    const reviewFn: LearningReviewFn = async (msgs) => {
      received = msgs;
    };
    scheduleLearningReview({
      sessionKey: "sess-3",
      messages: many,
      config: { enabled: true, maxReviewMessages: 6 },
      reviewFn,
    });
    await vi.waitFor(() => expect(received.length).toBe(6));
    expect(received[0]!.content).toBe("msg-14");
  });

  it("passes all messages when count is within limit", async () => {
    let received: LearningMessage[] = [];
    const reviewFn: LearningReviewFn = async (msgs) => {
      received = msgs;
    };
    scheduleLearningReview({
      sessionKey: "sess-4",
      messages: baseMessages,
      config: { enabled: true, maxReviewMessages: 40 },
      reviewFn,
    });
    await vi.waitFor(() => expect(received).toHaveLength(2));
  });
});

describe("scheduleLearningReview — error resilience", () => {
  it("does not propagate reviewFn errors to the caller", async () => {
    const reviewFn: LearningReviewFn = async () => {
      throw new Error("review crashed");
    };
    expect(() =>
      scheduleLearningReview({
        sessionKey: "sess-5",
        messages: baseMessages,
        config: { enabled: true },
        reviewFn,
      }),
    ).not.toThrow();
  });
});
