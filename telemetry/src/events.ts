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
} as const satisfies EventRegistry;

export type Events = typeof events;
