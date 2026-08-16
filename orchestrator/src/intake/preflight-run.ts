// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import type { TenantDb } from "@skeinkeeper/server";
import type { FoundryClient } from "../foundry/client.js";
import {
  identityFindingSeverity,
  verifyIdentityPreflight,
  type IdentityPreflightFinding,
  type IdentityPreflightInput,
  type IdentityPreflightResult,
} from "./preflight-identity.js";
import type { FindingCode, FindingKind, IntakeContext, IntakeFinding } from "./types.js";

export interface CollectIdentityPreflightArgs {
  campaignId: string;
  tenantDb: TenantDb;
  foundry: FoundryClient;
  expectedPlayers?: ReadonlyArray<{ discordUserId: string; displayName?: string }>;
  dmFoundryUserId?: string;
  operatorFoundryUserId?: string;
}

const KIND_TO_CODE: Record<IdentityPreflightFinding["kind"], FindingCode> = {
  "no-foundry-user": "IDENTITY_NO_FOUNDRY_USER",
  "foundry-user-not-owning-actor": "IDENTITY_FOUNDRY_USER_NOT_OWNING_ACTOR",
  "no-dm-foundry-user-designated": "IDENTITY_NO_DM_FOUNDRY_USER",
  "dm-foundry-user-is-operator-player-user": "IDENTITY_DM_IS_OPERATOR_PLAYER",
  "operator-foundry-user-not-gm-role": "IDENTITY_OPERATOR_NOT_GM_ROLE",
  "extra-foundry-users-not-mapped": "IDENTITY_EXTRA_FOUNDRY_USERS",
  "bridge-listusers-unavailable": "IDENTITY_BRIDGE_LISTUSERS_UNAVAILABLE",
};

export class IdentityPreflightBlockedError extends Error {
  readonly result: IdentityPreflightResult;

  constructor(result: IdentityPreflightResult) {
    super(formatIdentityBlockedMessage(result));
    this.name = "IdentityPreflightBlockedError";
    this.result = result;
  }
}

export function assertIdentityAllowsStart(result: IdentityPreflightResult): void {
  if (result.status === "critical-gaps") {
    throw new IdentityPreflightBlockedError(result);
  }
}

export async function collectIdentityPreflightInput(
  args: CollectIdentityPreflightArgs,
): Promise<IdentityPreflightInput> {
  const rows = args.tenantDb.playerCharacterMap.listByCampaign(args.campaignId);
  const identityMap = rows.map((row) => {
    const mapped: IdentityPreflightInput["identityMap"][number] = {
      discordUserId: row.discordUserId,
    };
    if (row.foundryUserId !== null && row.foundryUserId.length > 0) {
      mapped.foundryUserId = row.foundryUserId;
    }
    if (row.foundryActorId.length > 0) mapped.foundryActorId = row.foundryActorId;
    return mapped;
  });

  const fromArgs = args.expectedPlayers;
  const expectedPlayers =
    fromArgs !== undefined
      ? fromArgs
      : rows.map((row) => {
          const player: { discordUserId: string; displayName?: string } = {
            discordUserId: row.discordUserId,
          };
          if (row.displayName !== null && row.displayName.length > 0) {
            player.displayName = row.displayName;
          }
          return player;
        });

  let foundryUsers: IdentityPreflightInput["foundryUsers"] = [];
  let listUsersAvailable = true;
  try {
    const users = await args.foundry.listUsers();
    foundryUsers = users.map((u) => ({
      id: u.id,
      name: u.name,
      role: u.role ?? "PLAYER",
      ownedActorIds: u.ownedActorIds ?? [],
    }));
  } catch {
    listUsersAvailable = false;
  }

  const input: IdentityPreflightInput = {
    campaignId: args.campaignId,
    expectedPlayers,
    foundryUsers,
    identityMap,
    listUsersAvailable,
  };
  if (args.dmFoundryUserId !== undefined) input.dmFoundryUserId = args.dmFoundryUserId;
  if (args.operatorFoundryUserId !== undefined) {
    input.operatorFoundryUserId = args.operatorFoundryUserId;
  }
  return input;
}

export function identityFindingsToIntake(
  result: IdentityPreflightResult,
  input?: Pick<IdentityPreflightInput, "identityMap" | "operatorFoundryUserId">,
): IntakeFinding[] {
  return result.findings.map((finding) => {
    const severity = identityFindingSeverity(finding, input);
    const kind: FindingKind = severity === "critical" ? "critical-gap" : "recommendation";
    const mapped: IntakeFinding = {
      code: KIND_TO_CODE[finding.kind],
      kind,
      summary: identityFindingSummary(finding),
      dmOnly: false,
    };
    const detail = identityFindingDetail(finding);
    if (detail !== undefined) mapped.detail = detail;
    return mapped;
  });
}

/**
 * Merge identity findings into the intake report when the check is in-scope:
 * expected players were supplied, the persistent map has rows, or listUsers
 * failed (always surface that warning). Empty first-run worlds stay on the
 * TDD 0031 gate alone.
 */
export function shouldSurfaceIdentityFindings(
  ctx: Pick<IntakeContext, "expectedPlayers">,
  input: IdentityPreflightInput,
  result: IdentityPreflightResult,
): boolean {
  if (result.findings.some((f) => f.kind === "bridge-listusers-unavailable")) return true;
  if ((ctx.expectedPlayers?.length ?? 0) > 0) return true;
  if (input.identityMap.length > 0) return true;
  return false;
}

export function emitIdentityPreflightTelemetry(
  result: IdentityPreflightResult,
  input: IdentityPreflightInput,
  trigger: "start" | "voice-join" | "operator-command",
  onTelemetry?: (name: string, props?: Record<string, unknown>) => void,
): void {
  if (onTelemetry === undefined) return;
  const criticalCount = result.findings.filter(
    (f) => identityFindingSeverity(f, input) === "critical",
  ).length;
  onTelemetry("preflight.identity.ran", {
    trigger,
    playerCount: input.expectedPlayers.length,
    findingCount: result.findings.length,
    criticalCount,
  });
  for (const finding of result.findings) {
    onTelemetry("preflight.identity.finding", {
      kind: finding.kind,
      severity: identityFindingSeverity(finding, input),
    });
  }
  if (result.status === "critical-gaps" && trigger === "start") {
    onTelemetry("preflight.identity.blocked-start", { criticalCount });
  }
}

export async function runIdentityPreflight(args: {
  ctx: IntakeContext;
  tenantDb: TenantDb;
  foundry: FoundryClient;
  trigger: "start" | "voice-join" | "operator-command";
  expectedPlayers?: ReadonlyArray<{ discordUserId: string; displayName?: string }>;
  onTelemetry?: (name: string, props?: Record<string, unknown>) => void;
}): Promise<{
  input: IdentityPreflightInput;
  result: IdentityPreflightResult;
  findings: IntakeFinding[];
}> {
  const input = await collectIdentityPreflightInput({
    campaignId: args.ctx.campaignId,
    tenantDb: args.tenantDb,
    foundry: args.foundry,
    ...(args.expectedPlayers !== undefined
      ? { expectedPlayers: args.expectedPlayers }
      : args.ctx.expectedPlayers !== undefined
        ? { expectedPlayers: args.ctx.expectedPlayers }
        : {}),
    ...(args.ctx.dmFoundryUserId !== undefined
      ? { dmFoundryUserId: args.ctx.dmFoundryUserId }
      : {}),
    ...(args.ctx.operatorFoundryUserId !== undefined
      ? { operatorFoundryUserId: args.ctx.operatorFoundryUserId }
      : {}),
  });
  const result = verifyIdentityPreflight(input);
  emitIdentityPreflightTelemetry(result, input, args.trigger, args.onTelemetry);
  const findings = shouldSurfaceIdentityFindings(args.ctx, input, result)
    ? identityFindingsToIntake(result, input)
    : [];
  return { input, result, findings };
}

export async function executePreflightVerify(args: {
  ctx: IntakeContext;
  tenantDb: TenantDb;
  foundry: FoundryClient;
  player?: string;
  emit: (text: string) => Promise<void>;
  onTelemetry?: (name: string, props?: Record<string, unknown>) => void;
}): Promise<IdentityPreflightResult> {
  const expectedPlayers =
    args.player !== undefined
      ? [{ discordUserId: args.player.replace(/^@/, "") }]
      : args.ctx.expectedPlayers;
  const ran = await runIdentityPreflight({
    ctx: {
      ...args.ctx,
      ...(expectedPlayers !== undefined ? { expectedPlayers } : {}),
    },
    tenantDb: args.tenantDb,
    foundry: args.foundry,
    trigger: "operator-command",
    ...(expectedPlayers !== undefined ? { expectedPlayers } : {}),
    ...(args.onTelemetry !== undefined ? { onTelemetry: args.onTelemetry } : {}),
  });
  await args.emit(formatIdentityPreflightReport(ran.result));
  return ran.result;
}

export function formatIdentityPreflightReport(result: IdentityPreflightResult): string {
  if (result.status === "ok") return "Identity pre-flight: ok.";
  const lines = result.findings.map((f) => `- ${identityFindingSummary(f)}`);
  const header =
    result.status === "critical-gaps"
      ? "Identity pre-flight: critical gaps"
      : "Identity pre-flight: warnings";
  const resolution =
    result.status === "critical-gaps"
      ? "\nAdd the listed Foundry users + actor ownership and retry Start."
      : "";
  return `${header}\n${lines.join("\n")}${resolution}`;
}

function formatIdentityBlockedMessage(result: IdentityPreflightResult): string {
  const bits = result.findings.map((f) => identityFindingSummary(f));
  return (
    `Identity pre-flight blocked Start (${result.findings.map((f) => f.kind).join(", ")}): ` +
    `${bits.join("; ")}. Add the listed Foundry users + actor ownership and retry Start.`
  );
}

function identityFindingSummary(finding: IdentityPreflightFinding): string {
  switch (finding.kind) {
    case "no-foundry-user": {
      const who = finding.displayName ?? finding.discordUserId;
      return `${who} has no Foundry user.`;
    }
    case "foundry-user-not-owning-actor":
      return `Foundry user ${finding.foundryUserId} does not own actor ${finding.foundryActorId}.`;
    case "no-dm-foundry-user-designated":
      return "No DM Foundry user is designated for side-channel routing.";
    case "dm-foundry-user-is-operator-player-user":
      return `DM Foundry user ${finding.foundryUserId} is also the operator's player user.`;
    case "operator-foundry-user-not-gm-role":
      return `Operator Foundry user ${finding.foundryUserId} is not a GM-role user.`;
    case "extra-foundry-users-not-mapped":
      return `Foundry users not in the identity map: ${finding.foundryUserIds.join(", ")}.`;
    case "bridge-listusers-unavailable":
      return "Could not list Foundry users (bridge unavailable).";
  }
}

function identityFindingDetail(finding: IdentityPreflightFinding): string | undefined {
  switch (finding.kind) {
    case "no-foundry-user":
      return `discordUserId=${finding.discordUserId}`;
    case "foundry-user-not-owning-actor":
      return `discordUserId=${finding.discordUserId}`;
    default:
      return undefined;
  }
}
