// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import type { EventRegistry } from "./types.js";

export const events = {
  "app.started": {
    v: 1,
    description: "Skeinkeeper process started.",
    props: {} as { version: string; nodeVersion: string },
  },
  "session.started": {
    v: 1,
    description: "An RPG session began for a campaign.",
    props: {} as { campaignIdHash: string; rulesetId: string },
  },
  "session.ended": {
    v: 1,
    description: "An RPG session ended.",
    props: {} as {
      campaignIdHash: string;
      durationSecBucket: string;
      turnCount: number;
    },
  },
  "tool.called": {
    v: 1,
    description: "A typed tool was invoked by the orchestrator.",
    props: {} as {
      toolName: string;
      success: boolean;
      latencyMsBucket: string;
    },
  },
  "error.captured": {
    v: 1,
    description: "An unexpected error was captured for crash reporting.",
    props: {} as { errorClass: string; module: string },
  },
  "llm.completed": {
    v: 1,
    description:
      "An LLM completion finished. Tokens and duration are bucketed; no PII or prompt content.",
    props: {} as {
      providerName: string;
      modelTier: string;
      success: boolean;
      stopReason: string;
      inputTokensBucket: string;
      outputTokensBucket: string;
      cacheReadTokensBucket: string;
      durationMsBucket: string;
    },
  },
  "behavior_spec.loaded": {
    v: 1,
    description:
      "A Behavior Spec was loaded for a session. Reveals version + coarse size; no spec content.",
    props: {} as {
      version: string;
      sizeKbBucket: string;
    },
  },
  "intake.minimum.started": {
    v: 1,
    description: "Minimum session intake began.",
    props: {} as { campaignId: string; sessionId: string },
  },
  "intake.minimum.completed": {
    v: 1,
    description: "Minimum session intake finished.",
    props: {} as {
      campaignId: string;
      sessionId: string;
      durationMs: number;
      criticalCount: number;
    },
  },
  "intake.extended.completed": {
    v: 1,
    description: "Extended session intake finished.",
    props: {} as {
      campaignId: string;
      sessionId: string;
      durationMs: number;
      ambiguityCount: number;
      recommendationCount: number;
    },
  },
  "intake.finding.surfaced": {
    v: 1,
    description: "An intake finding was delivered to the operator.",
    props: {} as {
      campaignId: string;
      sessionId: string;
      findingCode: string;
      kind: string;
      dmOnly: boolean;
    },
  },
  "intake.finding.resolved": {
    v: 1,
    description: "The operator resolved an intake finding.",
    props: {} as {
      campaignId: string;
      sessionId: string;
      findingCode: string;
      resolutionId: string;
      latencyMs: number;
    },
  },
  "intake.gate.blocked": {
    v: 1,
    description: "announceReady was blocked by unresolved critical intake findings.",
    props: {} as { campaignId: string; sessionId: string; blockingFindings: string[] },
  },
} as const satisfies EventRegistry;

export type Events = typeof events;
