import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it, vi } from "vitest";
import {
  compressIfNeeded,
  DEFAULT_COMPRESSION_THRESHOLD_PERCENT,
  type SummarizeFn,
} from "./context-compressor.js";

// Control token estimates and pruning precisely
const mockEstimateTokens = vi.fn<(msgs: AgentMessage[]) => number>();
const mockPrune = vi.fn<
  (p: { messages: AgentMessage[]; maxContextTokens: number }) => {
    messages: AgentMessage[];
    droppedTokens: number;
    droppedChunks: number;
    droppedMessages: number;
    keptTokens: number;
    budgetTokens: number;
    droppedMessagesList: AgentMessage[];
  }
>();

vi.mock("./compaction.js", () => ({
  estimateMessagesTokens: (msgs: AgentMessage[]) => mockEstimateTokens(msgs),
  pruneHistoryForContextShare: (p: { messages: AgentMessage[]; maxContextTokens: number }) =>
    mockPrune(p),
}));

function makeMessages(n: number): AgentMessage[] {
  return Array.from({ length: n }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: `msg-${i}`,
    timestamp: i,
  })) as AgentMessage[];
}

function stubPrune(kept: AgentMessage[], droppedTokens = 100) {
  mockPrune.mockReturnValue({
    messages: kept,
    droppedTokens,
    droppedChunks: 1,
    droppedMessages: 2,
    keptTokens: 200,
    budgetTokens: 400,
    droppedMessagesList: [],
  });
}

describe("compressIfNeeded — threshold gating", () => {
  it("returns compressed:false when usage is below threshold", async () => {
    mockEstimateTokens.mockReturnValue(100); // 100 / 1000 = 10% < 80%
    const result = await compressIfNeeded({ messages: makeMessages(5), contextWindow: 1000 });
    expect(result.compressed).toBe(false);
  });

  it("returns compressed:false when contextWindow is 0", async () => {
    mockEstimateTokens.mockReturnValue(99999);
    const result = await compressIfNeeded({ messages: makeMessages(5), contextWindow: 0 });
    expect(result.compressed).toBe(false);
  });

  it("triggers when usage exceeds threshold", async () => {
    const all = makeMessages(10);
    const kept = makeMessages(5);
    // First call (initial check): 850 tokens in 1000-window = 85% > 80%
    // Second call (after prune check): 400 tokens = 40% < 80%
    mockEstimateTokens
      .mockReturnValueOnce(850) // initial check
      .mockReturnValue(400); // after prune
    stubPrune(kept);

    const result = await compressIfNeeded({ messages: all, contextWindow: 1000 });
    expect(result.compressed).toBe(true);
  });

  it("respects custom thresholdPercent", async () => {
    const all = makeMessages(10);
    const kept = makeMessages(8);
    mockEstimateTokens.mockReturnValueOnce(550).mockReturnValue(300); // 55% > 50%
    stubPrune(kept, 50);

    const result = await compressIfNeeded({
      messages: all,
      contextWindow: 1000,
      thresholdPercent: 50,
    });
    expect(result.compressed).toBe(true);
  });
});

describe("compressIfNeeded — step ordering", () => {
  it("calls pruneHistoryForContextShare before summarizeFn", async () => {
    const order: string[] = [];
    mockPrune.mockImplementation(({ messages }) => {
      order.push("prune");
      return {
        messages,
        droppedTokens: 100,
        droppedChunks: 1,
        droppedMessages: 2,
        keptTokens: 800,
        budgetTokens: 500,
        droppedMessagesList: [],
      };
    });
    // Initial: 850 over 80%, after prune: still 800 → 80% == threshold → call summarize
    mockEstimateTokens.mockReturnValueOnce(850).mockReturnValue(800);

    const summarizeFn: SummarizeFn = async (msgs) => {
      order.push("summarize");
      return msgs;
    };

    await compressIfNeeded({ messages: makeMessages(10), contextWindow: 1000, summarizeFn });

    expect(order.indexOf("prune")).toBeLessThan(order.indexOf("summarize"));
  });

  it("does not call summarizeFn when pruning reduces below threshold", async () => {
    const summarizeFn = vi.fn<SummarizeFn>(async (m) => m);
    // Initial: 850/1000 = 85%; after prune: 400/1000 = 40% < 80%
    mockEstimateTokens.mockReturnValueOnce(850).mockReturnValue(400);
    stubPrune(makeMessages(5));

    const result = await compressIfNeeded({
      messages: makeMessages(10),
      contextWindow: 1000,
      summarizeFn,
    });

    expect(summarizeFn).not.toHaveBeenCalled();
    if (result.compressed) {
      expect(result.summarized).toBe(false);
    }
  });

  it("sets summarized:false when no summarizeFn is provided", async () => {
    mockEstimateTokens.mockReturnValueOnce(850).mockReturnValue(850);
    stubPrune(makeMessages(10));

    const result = await compressIfNeeded({ messages: makeMessages(10), contextWindow: 1000 });
    if (result.compressed) {
      expect(result.summarized).toBe(false);
    }
  });

  it("calls summarizeFn when pruning is not enough", async () => {
    const summarizeFn = vi.fn<SummarizeFn>(async (m) => m);
    // After prune, still 850/1000 = 85% > 80%
    mockEstimateTokens.mockReturnValueOnce(900).mockReturnValue(850);
    stubPrune(makeMessages(10));

    const result = await compressIfNeeded({
      messages: makeMessages(10),
      contextWindow: 1000,
      summarizeFn,
    });

    expect(summarizeFn).toHaveBeenCalledOnce();
    if (result.compressed) {
      expect(result.summarized).toBe(true);
    }
  });
});

describe("compressIfNeeded — result shape", () => {
  it("returns prunedTokens from the prune step", async () => {
    mockEstimateTokens.mockReturnValueOnce(850).mockReturnValue(400);
    stubPrune(makeMessages(5), 450);

    const result = await compressIfNeeded({ messages: makeMessages(10), contextWindow: 1000 });
    expect(result.compressed).toBe(true);
    if (result.compressed) {
      expect(result.prunedTokens).toBe(450);
    }
  });

  it("uses DEFAULT_COMPRESSION_THRESHOLD_PERCENT = 80 by default", () => {
    expect(DEFAULT_COMPRESSION_THRESHOLD_PERCENT).toBe(80);
  });
});
