// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import type { TenantDb } from "@skeinkeeper/server";
import type { FoundryClient } from "../foundry/client.js";
import type { MemoryStore } from "../memory/store.js";
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
  const amb = extended.findings.filter((f) => f.kind === "ambiguity").length;
  const reco = extended.findings.filter((f) => f.kind === "recommendation").length;
  onTelemetry?.("intake.extended.completed", {
    campaignId: ctx.campaignId,
    sessionId: ctx.sessionId,
    durationMs: Date.now() - started,
    ambiguityCount: amb,
    recommendationCount: reco,
  });
  for (const f of extended.findings) {
    onTelemetry?.("intake.finding.surfaced", {
      campaignId: ctx.campaignId,
      sessionId: ctx.sessionId,
      findingCode: f.code,
      kind: f.kind,
      dmOnly: f.dmOnly,
    });
  }
  return extended;
}
