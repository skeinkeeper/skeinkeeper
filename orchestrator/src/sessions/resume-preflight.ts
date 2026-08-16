// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import type { TenantDb } from "@skeinkeeper/server";
import type { FoundryClient } from "../foundry/client.js";
import { identityFindingSeverity } from "../intake/preflight-identity.js";
import { runIdentityPreflight } from "../intake/preflight-run.js";
import type { IntakeContext } from "../intake/types.js";
import type { LifecyclePreflightOutcome } from "./lifecycle.js";

/**
 * Resume-side pre-flight (design doc 0039 §4 step 1). Re-runs TDD 0036's
 * verifier — with one resume-specific tightening: an unreachable `listUsers`
 * is CRITICAL here, not a warning. At Start, a missing bridge degrades to a
 * recommendation (ADR-0024); at resume-from-Foundry-down, an unanswered
 * `listUsers` means Foundry is still not back, so the resume must fail and
 * the state must stay `paused-foundry-down`.
 */
export async function runResumePreflight(args: {
  foundry: FoundryClient;
  tenantDb: TenantDb;
  ctx: IntakeContext;
  expectedPlayers?: ReadonlyArray<{ discordUserId: string; displayName?: string }>;
  onTelemetry?: (name: string, props?: Record<string, unknown>) => void;
}): Promise<LifecyclePreflightOutcome> {
  try {
    await args.foundry.listUsers();
  } catch {
    return {
      status: "critical-gaps",
      findings: [{ kind: "bridge-listusers-unavailable" }],
      criticalCount: 1,
    };
  }
  const { input, result } = await runIdentityPreflight({
    ctx: args.ctx,
    tenantDb: args.tenantDb,
    foundry: args.foundry,
    trigger: "operator-command",
    ...(args.expectedPlayers !== undefined ? { expectedPlayers: args.expectedPlayers } : {}),
    ...(args.onTelemetry !== undefined ? { onTelemetry: args.onTelemetry } : {}),
  });
  return {
    status: result.status,
    findings: result.findings,
    criticalCount: result.findings.filter(
      (finding) => identityFindingSeverity(finding, input) === "critical",
    ).length,
  };
}
