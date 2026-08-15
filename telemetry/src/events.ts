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
  "autosetup.scene.activated": {
    v: 1,
    description: "Initial scene activated autonomously.",
    props: {} as {
      campaignId: string;
      sessionId: string;
      reason: "already-active" | "single-starter" | "prior-resolved";
    },
  },
  "autosetup.scene.deferred": {
    v: 1,
    description: "Initial-scene activation deferred pending operator resolution.",
    props: {} as { campaignId: string; sessionId: string; candidateCount: number },
  },
  "autosetup.preload.created": {
    v: 1,
    description: "Pre-load created actors or items in the world.",
    props: {} as { campaignId: string; source: "compendium"; count: number },
  },
  "autosetup.preload.deferred": {
    v: 1,
    description: "Pre-load deferred to lazy-at-trigger.",
    props: {} as { campaignId: string; count: number },
  },
  "index.run.started": {
    v: 1,
    description: "World-content indexing run began.",
    props: {} as { campaignId: string; sessionId: string },
  },
  "index.run.completed": {
    v: 1,
    description: "World-content indexing run finished.",
    props: {} as {
      campaignId: string;
      sessionId: string;
      durationMs: number;
      perSourceCounts: Record<string, { added: number; updated: number; deleted: number }>;
    },
  },
  "index.run.source_failed": {
    v: 1,
    description: "One indexing source failed; others continued.",
    props: {} as { campaignId: string; source: string; reason: string },
  },
  "action.place_hidden_token": {
    v: 1,
    description: "Hidden-token placement attempted.",
    props: {} as {
      campaignId: string;
      sceneId: string;
      actorRefKind: "compendium" | "actor" | "name-pack";
      success: boolean;
    },
  },
  "action.reveal_token": {
    v: 1,
    description: "Token revealed to the table.",
    props: {} as { campaignId: string; success: boolean },
  },
  "action.hide_token": {
    v: 1,
    description: "Token hidden from the table.",
    props: {} as { campaignId: string; success: boolean },
  },
  "action.share_journal_to_audience": {
    v: 1,
    description: "Journal share attempted, with the path used.",
    props: {} as {
      campaignId: string;
      audienceKind: "table" | "player" | "gm";
      path: "foundry-public-chat" | "foundry-whisper" | "gm-noop";
      success: boolean;
    },
  },
  "action.distribute_loot": {
    v: 1,
    description: "Loot distribution attempted.",
    props: {} as {
      campaignId: string;
      recipientCount: number;
      itemCount: number;
      partialFailure: boolean;
    },
  },
  "perception.event_stream.wired": {
    v: 1,
    description: "Foundry event stream wired at session start.",
    props: {} as { campaignId: string; kind: "null" | "mock" | "real" },
  },
  "surface.emit": {
    v: 1,
    description: "An outbound surface emit succeeded.",
    props: {} as {
      surface: string;
      audience: { kind: "table" | "player" | "gm"; player?: string };
      latencyMs: number;
    },
  },
  "surface.emit.failed": {
    v: 1,
    description: "An outbound surface emit failed or had no handling surface.",
    props: {} as {
      surface: string;
      audience: { kind: "table" | "player" | "gm"; player?: string };
      reason: string;
    },
  },
  "surface.input": {
    v: 1,
    description: "An inbound surface event was received. Kind only; no content.",
    props: {} as { surface: string; kind: string },
  },
  "surface.command.parsed": {
    v: 1,
    description: "A Foundry /skeinkeeper command was parsed. Verb only; no args.",
    props: {} as { verb: string; ok: boolean },
  },
} as const satisfies EventRegistry;

export type Events = typeof events;
