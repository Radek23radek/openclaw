// Portions derived from Hermes Agent (MIT) - NousResearch
// https://github.com/NousResearch/hermes-agent
//
// Post-turn background skill-learning review.
// When learning.enabled: true, schedules a deferred async task after each
// completed turn. The task runs inside runAsBackgroundReview so that any
// skill_manage calls tag their output as agent_created: true.

import type { LearningConfig } from "../../config/types.openclaw.js";
import { enqueueCommandInLane } from "../../process/command-queue.js";
import { runAsBackgroundReview } from "../skills/skill-provenance.js";
import { resolveSessionLane } from "./lanes.js";
import { log } from "./logger.js";

const LEARNING_REVIEW_LANE_SUFFIX = ":learning-review";

export type LearningMessage = {
  role: "user" | "assistant";
  content: string;
};

export type LearningReviewFn = (messages: LearningMessage[]) => Promise<void>;

type LearningReviewWorkerParams = {
  sessionKey: string;
  messages: LearningMessage[];
  reviewFn: LearningReviewFn;
};

type ScheduleLearningReviewParams = {
  sessionKey: string;
  messages: LearningMessage[];
  config: LearningConfig | undefined;
  reviewFn: LearningReviewFn;
};

const DEFAULT_MAX_REVIEW_MESSAGES = 40;
const DEFAULT_MIN_ASSISTANT_MESSAGES = 1;

function resolveLearningReviewLane(sessionKey: string): string {
  return `${resolveSessionLane(sessionKey)}${LEARNING_REVIEW_LANE_SUFFIX}`;
}

function isLearningEnabled(config: LearningConfig | undefined): boolean {
  return config?.enabled === true;
}

function filterReviewMessages(messages: LearningMessage[], maxMessages: number): LearningMessage[] {
  return messages.slice(-maxMessages);
}

async function runLearningReviewWorker(params: LearningReviewWorkerParams): Promise<void> {
  try {
    await runAsBackgroundReview(async () => {
      await params.reviewFn(params.messages);
    });
  } catch (err) {
    log.warn(`learning review failed for session ${params.sessionKey}: ${String(err)}`);
  }
}

/**
 * Schedule a deferred post-turn skill-learning review.
 *
 * No-op when learning.enabled !== true or when there are not enough
 * assistant messages to warrant a review.
 *
 * The reviewFn runs inside runAsBackgroundReview so all skill_manage
 * calls within it tag the created skill as agent_created: true.
 */
export function scheduleLearningReview(params: ScheduleLearningReviewParams): void {
  if (!isLearningEnabled(params.config)) {
    return;
  }

  const minAssistant = params.config?.minAssistantMessages ?? DEFAULT_MIN_ASSISTANT_MESSAGES;
  const assistantCount = params.messages.filter((m) => m.role === "assistant").length;
  if (assistantCount < minAssistant) {
    return;
  }

  const maxMessages = params.config?.maxReviewMessages ?? DEFAULT_MAX_REVIEW_MESSAGES;
  const trimmedMessages = filterReviewMessages(params.messages, maxMessages);

  const lane = resolveLearningReviewLane(params.sessionKey);

  void enqueueCommandInLane(lane, () =>
    runLearningReviewWorker({
      sessionKey: params.sessionKey,
      messages: trimmedMessages,
      reviewFn: params.reviewFn,
    }),
  ).catch((err) => {
    log.warn(`failed to enqueue learning review for session ${params.sessionKey}: ${String(err)}`);
  });
}
