// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import type { TenantDb } from "@skeinkeeper/server";
import type { FoundryClient } from "../foundry/client.js";
import type { MemoryStore } from "../memory/store.js";
import { dispatchPostIntakeAutosetup } from "../autosetup/dispatch.js";
import type { VerifyIdentityPreflight } from "../autosetup/identity-preflight.js";
import type { EmbeddingProvider } from "../interfaces/embedding.js";
import type { SessionRunState } from "../session/run-state.js";
import type { WorldContentReader } from "../autosetup/world-types.js";
import { persistSurfacedFindings } from "./persist.js";
import { formatIntakeReportForOperator } from "./report.js";
import {
  announceReadyAllowed,
  createIntakeResolutionState,
  type IntakeResolutionState,
} from "./resolve.js";
import { runExtendedIntake, runMinimumIntake } from "./runner.js";
import type {
  ExtendedIntakeResult,
  FindingCode,
  IntakeContext,
  IntakeOperatorPayload,
  MinimumIntakeResult,
} from "./types.js";

export interface SessionStartIntakeDeps {
  ctx: IntakeContext;
  foundry: FoundryClient;
  memory: MemoryStore;
  tenantDb: TenantDb;
  onTelemetry?: (name: string, props?: Record<string, unknown>) => void;
  embed?: EmbeddingProvider;
  worldContent?: WorldContentReader;
  runState?: SessionRunState;
  verifyIdentityPreflight?: VerifyIdentityPreflight;
}

export interface SessionStartIntakeResult {
  ready: boolean;
  minimum: MinimumIntakeResult;
  state: IntakeResolutionState;
  blockingFindings: FindingCode[];
  report: IntakeOperatorPayload;
  /** Started only when minimum intake is unblocked; does not gate ready. */
  extended?: Promise<ExtendedIntakeResult>;
}

export async function runSessionStartIntake(
  deps: SessionStartIntakeDeps,
): Promise<SessionStartIntakeResult> {
  const { ctx, foundry, memory, tenantDb, onTelemetry } = deps;
  onTelemetry?.("intake.minimum.started", {
    campaignId: ctx.campaignId,
    sessionId: ctx.sessionId,
  });
  const started = Date.now();
  const minimum = await runMinimumIntake(ctx, foundry, memory, tenantDb);
  const surfaced = persistSurfacedFindings(
    tenantDb,
    ctx.campaignId,
    ctx.sessionId,
    minimum.criticalFindings,
  );
  const state = createIntakeResolutionState(surfaced, ctx.sessionConfig.intake);
  const blockingFindings = state.findings
    .filter((f) => f.kind === "critical-gap")
    .map((f) => f.code);
  const ready = announceReadyAllowed(state);
  onTelemetry?.("intake.minimum.completed", {
    campaignId: ctx.campaignId,
    sessionId: ctx.sessionId,
    durationMs: Date.now() - started,
    criticalCount: blockingFindings.length,
  });
  for (const f of surfaced) {
    onTelemetry?.("intake.finding.surfaced", {
      campaignId: ctx.campaignId,
      sessionId: ctx.sessionId,
      findingCode: f.code,
      kind: f.kind,
      dmOnly: f.dmOnly,
    });
  }
  if (!ready) {
    onTelemetry?.("intake.gate.blocked", {
      campaignId: ctx.campaignId,
      sessionId: ctx.sessionId,
      blockingFindings,
    });
  }

  const report = formatIntakeReportForOperator(surfaced);
  const result: SessionStartIntakeResult = {
    ready,
    minimum,
    state,
    blockingFindings,
    report,
  };
  if (ready) {
    result.extended = kickExtendedIntake(deps);
  }
  return result;
}

export async function kickExtendedIntake(
  deps: SessionStartIntakeDeps,
): Promise<ExtendedIntakeResult> {
  const { ctx, foundry, memory, tenantDb, onTelemetry } = deps;
  const started = Date.now();
  const minimum = await runMinimumIntake(ctx, foundry, memory, tenantDb);
  const extended = await runExtendedIntake(ctx, foundry, memory, minimum, tenantDb);
  const party = await foundry.listPartyActors();
  const partyActorIds = party.map((a) => a.id);
  const dispatched = await dispatchPostIntakeAutosetup({
    intake: extended,
    sessionConfig: ctx.sessionConfig,
    foundry,
    campaignId: ctx.campaignId,
    sessionId: ctx.sessionId,
    memory,
    partyActorIds,
    ...(deps.embed !== undefined ? { embed: deps.embed } : {}),
    ...(deps.worldContent !== undefined ? { worldContent: deps.worldContent } : {}),
    ...(deps.runState !== undefined ? { runState: deps.runState } : {}),
    ...(deps.verifyIdentityPreflight !== undefined
      ? { verifyIdentityPreflight: deps.verifyIdentityPreflight }
      : {}),
    ...(onTelemetry !== undefined ? { onTelemetry } : {}),
  });
  const withScene: ExtendedIntakeResult = {
    ...extended,
    findings: dispatched.findings,
    ...(dispatched.actions.length > 0 ? { actions: dispatched.actions } : {}),
  };
  const amb = withScene.findings.filter((f) => f.kind === "ambiguity").length;
  const reco = withScene.findings.filter((f) => f.kind === "recommendation").length;
  onTelemetry?.("intake.extended.completed", {
    campaignId: ctx.campaignId,
    sessionId: ctx.sessionId,
    durationMs: Date.now() - started,
    ambiguityCount: amb,
    recommendationCount: reco,
  });
  for (const f of withScene.findings) {
    onTelemetry?.("intake.finding.surfaced", {
      campaignId: ctx.campaignId,
      sessionId: ctx.sessionId,
      findingCode: f.code,
      kind: f.kind,
      dmOnly: f.dmOnly,
    });
  }
  return withScene;
}
