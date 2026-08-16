// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

/**
 * 3-way identity pre-flight verifier (TDD 0036). Pure: same input → same
 * output. Critical gaps block Start / suppress per-player onboarding;
 * warnings and info do not.
 */

export interface IdentityPreflightInput {
  campaignId: string;
  expectedPlayers: ReadonlyArray<{ discordUserId: string; displayName?: string }>;
  foundryUsers: ReadonlyArray<{
    id: string;
    name: string;
    role: "GAMEMASTER" | "ASSISTANT" | "TRUSTED" | "PLAYER" | string;
    ownedActorIds: ReadonlyArray<string>;
  }>;
  identityMap: ReadonlyArray<{
    discordUserId: string;
    foundryUserId?: string | null;
    foundryActorId?: string | null;
  }>;
  dmFoundryUserId?: string;
  operatorFoundryUserId?: string;
  /** When false, listUsers failed — return warnings-only, do not block Start. */
  listUsersAvailable?: boolean;
}

export type IdentityPreflightFinding =
  | { kind: "no-foundry-user"; discordUserId: string; displayName?: string }
  | {
      kind: "foundry-user-not-owning-actor";
      discordUserId: string;
      foundryUserId: string;
      foundryActorId: string;
    }
  | { kind: "no-dm-foundry-user-designated" }
  | { kind: "dm-foundry-user-is-operator-player-user"; foundryUserId: string }
  | { kind: "operator-foundry-user-not-gm-role"; foundryUserId: string }
  | { kind: "extra-foundry-users-not-mapped"; foundryUserIds: ReadonlyArray<string> }
  | { kind: "bridge-listusers-unavailable" };

export interface IdentityPreflightResult {
  status: "ok" | "critical-gaps" | "warnings-only";
  findings: ReadonlyArray<IdentityPreflightFinding>;
}

export type IdentityFindingSeverity = "critical" | "warning" | "info";

export function identityFindingSeverity(
  finding: IdentityPreflightFinding,
  input?: Pick<IdentityPreflightInput, "identityMap" | "operatorFoundryUserId">,
): IdentityFindingSeverity {
  switch (finding.kind) {
    case "no-foundry-user":
    case "foundry-user-not-owning-actor":
    case "no-dm-foundry-user-designated":
      return "critical";
    case "dm-foundry-user-is-operator-player-user":
      return operatorIsAlsoPlayer(input) ? "critical" : "warning";
    case "operator-foundry-user-not-gm-role":
    case "bridge-listusers-unavailable":
      return "warning";
    case "extra-foundry-users-not-mapped":
      return "info";
  }
}

export function verifyIdentityPreflight(input: IdentityPreflightInput): IdentityPreflightResult {
  if (input.listUsersAvailable === false) {
    return { status: "warnings-only", findings: [{ kind: "bridge-listusers-unavailable" }] };
  }

  const findings: IdentityPreflightFinding[] = [];
  const usersById = new Map(input.foundryUsers.map((u) => [u.id, u]));
  const mapByDiscord = new Map(input.identityMap.map((row) => [row.discordUserId, row]));
  const mappedFoundryIds = new Set(
    input.identityMap
      .map((row) => row.foundryUserId)
      .filter((id): id is string => typeof id === "string" && id.length > 0),
  );

  if (input.dmFoundryUserId === undefined || input.dmFoundryUserId.length === 0) {
    findings.push({ kind: "no-dm-foundry-user-designated" });
  } else if (
    operatorIsAlsoPlayer(input) &&
    input.dmFoundryUserId === playerFoundryIdOfOperator(input)
  ) {
    findings.push({
      kind: "dm-foundry-user-is-operator-player-user",
      foundryUserId: input.dmFoundryUserId,
    });
  }

  const operatorId = input.operatorFoundryUserId;
  if (operatorId !== undefined && operatorId.length > 0) {
    const opUser = usersById.get(operatorId);
    if (opUser !== undefined && !isGmRole(opUser.role)) {
      findings.push({ kind: "operator-foundry-user-not-gm-role", foundryUserId: operatorId });
    }
  }

  for (const player of input.expectedPlayers) {
    const row = mapByDiscord.get(player.discordUserId);
    const foundryUserId = row?.foundryUserId;
    if (foundryUserId === undefined || foundryUserId === null || foundryUserId.length === 0) {
      const finding: IdentityPreflightFinding = {
        kind: "no-foundry-user",
        discordUserId: player.discordUserId,
      };
      if (player.displayName !== undefined) finding.displayName = player.displayName;
      findings.push(finding);
      continue;
    }
    const actorId = row?.foundryActorId;
    const user = usersById.get(foundryUserId);
    const owners = input.foundryUsers.filter((u) =>
      actorId !== undefined && actorId !== null && actorId.length > 0
        ? u.ownedActorIds.includes(actorId)
        : false,
    );
    const ownsMapped =
      user !== undefined &&
      actorId !== undefined &&
      actorId !== null &&
      user.ownedActorIds.includes(actorId);
    if (
      user === undefined ||
      actorId === undefined ||
      actorId === null ||
      actorId.length === 0 ||
      !ownsMapped ||
      owners.length !== 1
    ) {
      findings.push({
        kind: "foundry-user-not-owning-actor",
        discordUserId: player.discordUserId,
        foundryUserId,
        foundryActorId: actorId ?? "",
      });
    }
  }

  const reserved = new Set<string>();
  if (input.dmFoundryUserId !== undefined) reserved.add(input.dmFoundryUserId);
  if (input.operatorFoundryUserId !== undefined) reserved.add(input.operatorFoundryUserId);
  const extras = input.foundryUsers
    .map((u) => u.id)
    .filter((id) => !mappedFoundryIds.has(id) && !reserved.has(id));
  if (extras.length > 0) {
    findings.push({ kind: "extra-foundry-users-not-mapped", foundryUserIds: extras });
  }

  return { status: statusOf(findings, input), findings };
}

function statusOf(
  findings: ReadonlyArray<IdentityPreflightFinding>,
  input: IdentityPreflightInput,
): IdentityPreflightResult["status"] {
  if (findings.length === 0) return "ok";
  const anyCritical = findings.some((f) => identityFindingSeverity(f, input) === "critical");
  return anyCritical ? "critical-gaps" : "warnings-only";
}

function isGmRole(role: string): boolean {
  return role === "GAMEMASTER" || role === "ASSISTANT";
}

function operatorIsAlsoPlayer(
  input: Pick<IdentityPreflightInput, "identityMap" | "operatorFoundryUserId"> | undefined,
): boolean {
  if (input === undefined) return false;
  const playerId = playerFoundryIdOfOperator(input);
  return playerId !== undefined;
}

function playerFoundryIdOfOperator(
  input: Pick<IdentityPreflightInput, "identityMap" | "operatorFoundryUserId">,
): string | undefined {
  const op = input.operatorFoundryUserId;
  if (op === undefined || op.length === 0) return undefined;
  const asPlayer = input.identityMap.find((row) => row.foundryUserId === op);
  return asPlayer?.foundryUserId ?? undefined;
}
