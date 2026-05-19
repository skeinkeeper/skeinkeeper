// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import type { TenantDb } from "@skeinkeeper/server";
import type {
  WarmStateSnapshot,
  CharacterSnapshot,
  NpcSnapshot,
  LocationSnapshot,
} from "./hot_context.js";

/**
 * Warm-tier reader (per ADR-0002). The orchestrator calls this once per
 * turn to assemble the snapshot it then hands to assembleHotContext.
 *
 * No writes here. Per ADR-0003, warm-state mutations occur only via the
 * tool dispatcher. The lint rule for `no-restricted-imports` on Drizzle
 * schema gates direct writes from non-server packages; this module is
 * read-only by construction.
 */
export function buildWarmStateSnapshot(
  tenantDb: TenantDb,
  campaignId: string,
): WarmStateSnapshot {
  const campaign = tenantDb.campaigns.get(campaignId);
  if (!campaign) throw new Error(`Campaign ${campaignId} not found`);

  const rawCharacters = tenantDb.characters.listByCampaign(campaignId);
  const party: CharacterSnapshot[] = rawCharacters.map((ch) => ({
    id: ch.id,
    name: ch.name,
    hp: ch.hp,
    maxHp: ch.maxHp,
    conditions: extractConditions(ch.rulesetDataJson),
  }));

  const rawNpcs = tenantDb.npcs.listByCampaign(campaignId).filter((n) => n.alive);
  const activeNpcs: NpcSnapshot[] = rawNpcs.map((n) => {
    const out: NpcSnapshot = {
      id: n.id,
      name: n.name,
      disposition: (n.disposition as NpcSnapshot["disposition"]) ?? "neutral",
    };
    if (n.mannerism) out.mannerism = n.mannerism;
    if (n.motivation) out.motivation = n.motivation;
    return out;
  });

  const currentLocation = resolveCurrentLocation(tenantDb, campaignId);

  return {
    campaign: { id: campaign.id, name: campaign.name, rulesetId: campaign.rulesetId },
    party,
    currentLocation,
    activeNpcs,
  };
}

/**
 * Build a one-paragraph natural-language summary of the warm state,
 * suitable for surfacing in the operator's web UI or the audit log.
 * Distinct from formatHotContextAsText (which targets the LLM prompt).
 */
export function summarizeWarmStateForOperator(snapshot: WarmStateSnapshot): string {
  const partyStr =
    snapshot.party.length === 0
      ? "no characters created yet"
      : snapshot.party
          .map((c) => {
            const cond = c.conditions.length > 0 ? ` (${c.conditions.join(", ")})` : "";
            return `${c.name} ${c.hp}/${c.maxHp} HP${cond}`;
          })
          .join("; ");
  const loc = snapshot.currentLocation ? `in ${snapshot.currentLocation.name}` : "with no set location";
  const npcs =
    snapshot.activeNpcs.length === 0
      ? ""
      : ` Active NPCs: ${snapshot.activeNpcs.map((n) => n.name).join(", ")}.`;
  return `Campaign "${snapshot.campaign.name}" ${loc}. Party: ${partyStr}.${npcs}`;
}

function extractConditions(rulesetDataJson: string): ReadonlyArray<string> {
  try {
    const data = JSON.parse(rulesetDataJson || "{}") as Record<string, unknown>;
    const conds = data.conditions;
    return Array.isArray(conds) ? (conds as string[]) : [];
  } catch {
    return [];
  }
}

function resolveCurrentLocation(
  tenantDb: TenantDb,
  campaignId: string,
): LocationSnapshot | null {
  const flags = tenantDb.questFlags.listByCampaign(campaignId);
  const partyLocFlag = flags.find((f) => f.key === "party.location");
  if (!partyLocFlag) return null;
  const locations = tenantDb.locations.listByCampaign(campaignId);
  const loc = locations.find((l) => l.id === partyLocFlag.value);
  if (!loc) return { id: partyLocFlag.value, name: partyLocFlag.value };
  const out: LocationSnapshot = { id: loc.id, name: loc.name };
  if (loc.description) out.description = loc.description;
  return out;
}
