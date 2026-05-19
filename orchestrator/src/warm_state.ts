// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import type { TenantDb } from "@skeinkeeper/server";
import type { FoundryClient } from "./foundry/client.js";
import type { LocationSnapshot, WarmStateSnapshot } from "./hot_context.js";
import { renderActorState } from "./foundry/render.js";

/**
 * Warm-tier reader (per ADR-0002). The orchestrator calls this once
 * per turn to assemble the snapshot it then hands to
 * assembleHotContext.
 *
 * Per design doc 0007, mechanical state (party, NPCs, scene) is read
 * from Foundry via the FoundryClient. AI-DM-specific state (campaign
 * metadata, quest flags) is read from TenantDb. The orchestrator
 * stitches the two sources together and produces a single snapshot.
 *
 * No writes here. Per ADR-0003, warm-state mutations occur only via
 * the tool dispatcher.
 */
export async function buildWarmStateSnapshot(
  foundry: FoundryClient,
  tenantDb: TenantDb,
  campaignId: string,
): Promise<WarmStateSnapshot> {
  const campaign = tenantDb.campaigns.get(campaignId);
  if (!campaign) throw new Error(`Campaign ${campaignId} not found`);

  const party = await foundry.listPartyActors();
  const scene = await foundry.getActiveScene();
  const activeNpcs = scene
    ? (await foundry.listSceneActors(scene.id)).filter((a) => a.type === "npc")
    : [];

  let currentLocation: LocationSnapshot | null = null;
  if (scene) {
    currentLocation = { id: scene.id, name: scene.name };
    if (scene.description) currentLocation.description = scene.description;
  }

  return {
    campaign: { id: campaign.id, name: campaign.name, rulesetId: campaign.rulesetId },
    party,
    activeNpcs,
    currentLocation,
  };
}

/**
 * Build a one-line natural-language summary of the warm state,
 * suitable for the operator-facing UI or audit-log surfaces.
 * Distinct from formatHotContextAsText (which targets the LLM prompt).
 */
export function summarizeWarmStateForOperator(snapshot: WarmStateSnapshot): string {
  const partyStr =
    snapshot.party.length === 0
      ? "no party loaded"
      : snapshot.party.map((a) => renderActorState(a)).join("; ");
  const loc = snapshot.currentLocation
    ? `in ${snapshot.currentLocation.name}`
    : "with no active scene";
  const npcs =
    snapshot.activeNpcs.length === 0
      ? ""
      : ` Active NPCs: ${snapshot.activeNpcs.map((n) => n.name).join(", ")}.`;
  return `Campaign "${snapshot.campaign.name}" ${loc}. Party: ${partyStr}.${npcs}`;
}
