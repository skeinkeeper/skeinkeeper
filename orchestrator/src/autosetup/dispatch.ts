// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import type { FoundryClient } from "../foundry/client.js";
import type { EmbeddingProvider } from "../interfaces/embedding.js";
import type { MemoryStore } from "../memory/store.js";
import type {
  ExtendedIntakeResult,
  IntakeFinding,
  IntakeSessionConfigSlice,
} from "../intake/types.js";
import type { SessionRunState } from "../session/run-state.js";
import { applyInitialScene, stripSceneFindings } from "./initial-scene.js";
import { refreshIndex, type RefreshReport } from "./index-refresh.js";
import { invokeIdentityPreflight, type VerifyIdentityPreflight } from "./identity-preflight.js";
import { preloadExpectedContent, type PreloadReport } from "./preload.js";
import type { WorldContentReader } from "./world-types.js";

export interface DispatchAutosetupArgs {
  intake: ExtendedIntakeResult;
  sessionConfig: IntakeSessionConfigSlice;
  foundry: FoundryClient;
  campaignId: string;
  sessionId: string;
  memory?: MemoryStore;
  embed?: EmbeddingProvider;
  worldContent?: WorldContentReader;
  runState?: SessionRunState;
  partyActorIds?: ReadonlyArray<string>;
  verifyIdentityPreflight?: VerifyIdentityPreflight;
  onTelemetry?: (name: string, props?: Record<string, unknown>) => void;
}

export interface DispatchAutosetupResult {
  findings: IntakeFinding[];
  actions: string[];
  index?: Promise<RefreshReport | undefined>;
  preload?: Promise<PreloadReport | undefined>;
}

export async function dispatchPostIntakeAutosetup(
  args: DispatchAutosetupArgs,
): Promise<DispatchAutosetupResult> {
  const scene = await applyInitialScene(args.intake, args.sessionConfig, args.foundry, {
    campaignId: args.campaignId,
    sessionId: args.sessionId,
    ...(args.onTelemetry !== undefined ? { onTelemetry: args.onTelemetry } : {}),
  });
  await invokeIdentityPreflight(args.verifyIdentityPreflight, {
    campaignId: args.campaignId,
    sessionId: args.sessionId,
  });

  const findings = [...stripSceneFindings(args.intake.findings), ...scene.findings];
  const actions = [
    ...scene.actions,
    ...(scene.activationError !== undefined ? [scene.activationError] : []),
  ];

  let index: Promise<RefreshReport | undefined> | undefined;
  if (args.worldContent !== undefined && args.memory !== undefined && args.embed !== undefined) {
    const world = args.worldContent;
    const memory = args.memory;
    const embed = args.embed;
    index = refreshIndex(world, memory, embed, {
      campaignId: args.campaignId,
      sessionId: args.sessionId,
      ...(args.partyActorIds !== undefined ? { partyActorIds: args.partyActorIds } : {}),
      ...(args.onTelemetry !== undefined ? { onTelemetry: args.onTelemetry } : {}),
    })
      .then((report) => {
        if (args.runState !== undefined) args.runState.coldIndexReady = true;
        return report;
      })
      .catch(() => {
        if (args.runState !== undefined) args.runState.coldIndexReady = true;
        return undefined;
      });
  }

  let preload: Promise<PreloadReport | undefined> | undefined;
  if (args.embed !== undefined) {
    preload = preloadExpectedContent(args.foundry, args.intake, {
      campaignId: args.campaignId,
      ...(args.onTelemetry !== undefined ? { onTelemetry: args.onTelemetry } : {}),
    }).catch(() => undefined);
  }

  return {
    findings,
    actions,
    ...(index !== undefined ? { index } : {}),
    ...(preload !== undefined ? { preload } : {}),
  };
}
