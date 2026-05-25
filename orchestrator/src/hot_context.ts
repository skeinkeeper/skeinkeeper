// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

/**
 * Hot tier of the four-tier memory model (ADR-0002). Assembles per-turn
 * prompt context from a warm-state snapshot and a dialogue history.
 *
 * Per design doc 0007, the warm-state snapshot is sourced from Foundry
 * (via FoundryClient) for mechanical state, plus TenantDb for AI-DM
 * state (quest flags). This module is a pure function over the
 * already-assembled snapshot — see `warm_state.ts` for the assembler.
 */

import type { Audience, ConversationId } from "@skeinkeeper/server";
import type { FoundryActor, FoundrySceneRef } from "./foundry/client.js";
import { renderActorState } from "./foundry/render.js";
import { formatSpeakerLine } from "./util/format.js";

export interface CampaignSnapshot {
  id: string;
  name: string;
  rulesetId: string;
}

export interface LocationSnapshot {
  /** Foundry scene ID. */
  id: string;
  name: string;
  description?: string;
}

export interface DialogueTurn {
  /** Discord user ID for player turns, "operator" for operator interjections,
   *  "system" for orchestrator notes, "narrator" for AI narration. */
  speaker: string;
  /** Optional display name to surface in the formatted context. */
  displayName?: string;
  text: string;
  timestamp: number;
  /** Who may see this turn (design doc 0026). Absent = "table" (shared). */
  audience?: Audience;
  /** Which conversation thread this turn belongs to. Absent = "table". */
  conversationId?: ConversationId;
}

export interface WarmStateSnapshot {
  campaign: CampaignSnapshot;
  party: ReadonlyArray<FoundryActor>;
  activeNpcs: ReadonlyArray<FoundryActor>;
  currentLocation: LocationSnapshot | null;
  /** Scenes the AI can switch the active map to (ADR-0015). Optional so
   *  hand-built snapshots in tests can omit it. */
  availableScenes?: ReadonlyArray<FoundrySceneRef>;
}

/**
 * A retrieved memory chunk for hot-context injection (design doc 0019 §5).
 * A minimal shape so this module doesn't depend on the memory store types.
 */
export interface RetrievedMemoryChunk {
  kind: string;
  text: string;
}

/**
 * A human currently in the voice channel, with their character mapping if
 * known (design doc 0023). Sourced by the always-listening loop from
 * `presence` events + `player_character_map`. Surfaced in hot context so the
 * AI can run the onboarding ritual and call `record_player_character` with the
 * right Discord user ID + Foundry actor ID.
 */
export interface PresentPlayer {
  /** Discord user ID. PII. */
  discordId: string;
  displayName?: string;
  /** Foundry actor ID this player is mapped to, if any. */
  mappedActorId?: string;
}

export interface HotContextOptions {
  /** Number of most recent dialogue turns to include. Default 20. */
  windowSize?: number;
  /** Cold/episodic records retrieved for this turn (already ranked). */
  retrievedMemory?: ReadonlyArray<RetrievedMemoryChunk>;
  /** Voice-channel roster + mappings for the onboarding ritual (doc 0023). */
  presentPlayers?: ReadonlyArray<PresentPlayer>;
}

export interface HotContext extends WarmStateSnapshot {
  recentDialogue: ReadonlyArray<DialogueTurn>;
  retrievedMemory: ReadonlyArray<RetrievedMemoryChunk>;
  presentPlayers: ReadonlyArray<PresentPlayer>;
}

const DEFAULT_WINDOW_SIZE = 20;

export function assembleHotContext(
  warm: WarmStateSnapshot,
  dialogueHistory: ReadonlyArray<DialogueTurn>,
  options: HotContextOptions = {},
): HotContext {
  const windowSize = options.windowSize ?? DEFAULT_WINDOW_SIZE;
  if (windowSize < 0) throw new Error("windowSize must be >= 0");
  const recentDialogue =
    dialogueHistory.length <= windowSize
      ? dialogueHistory
      : dialogueHistory.slice(dialogueHistory.length - windowSize);

  return {
    ...warm,
    recentDialogue,
    retrievedMemory: options.retrievedMemory ?? [],
    presentPlayers: options.presentPlayers ?? [],
  };
}

/**
 * Render the hot context as a plain-text block suitable for injection
 * into a system prompt. The session embeds it as the leading user-message
 * block (see session.ts).
 */
export function formatHotContextAsText(ctx: HotContext): string {
  const lines: string[] = [];
  lines.push(`Campaign: ${ctx.campaign.name} (${ctx.campaign.rulesetId})`);

  if (ctx.currentLocation) {
    lines.push(`Current location: ${ctx.currentLocation.name}`);
    if (ctx.currentLocation.description) {
      lines.push(`  ${ctx.currentLocation.description}`);
    }
  } else {
    lines.push("Current location: (no active scene)");
  }

  if (ctx.party.length > 0) {
    lines.push("");
    lines.push("Party:");
    for (const actor of ctx.party) {
      lines.push(`  - ${renderActorState(actor)}`);
    }
  }

  if (ctx.activeNpcs.length > 0) {
    lines.push("");
    lines.push("Active NPCs (on this scene):");
    for (const actor of ctx.activeNpcs) {
      lines.push(`  - ${renderActorState(actor)}`);
    }
  }

  const otherScenes = (ctx.availableScenes ?? []).filter((s) => !s.active);
  if (otherScenes.length > 0) {
    lines.push("");
    lines.push("Scenes you can switch the map to (use move_party with the name):");
    for (const s of otherScenes) {
      lines.push(`  - ${s.name}`);
    }
  }

  if (ctx.presentPlayers.length > 0) {
    const characterActors = ctx.party.filter((a) => a.type === "character");
    const mappedActorIds = new Set(
      ctx.presentPlayers.map((p) => p.mappedActorId).filter((id): id is string => id !== undefined),
    );
    const actorName = (id: string): string =>
      ctx.party.find((a) => a.id === id)?.name ?? `actor ${id}`;

    lines.push("");
    lines.push("Players at the table (Discord → character):");
    for (const p of ctx.presentPlayers) {
      const who = p.displayName ?? p.discordId;
      const mapping =
        p.mappedActorId !== undefined
          ? `${actorName(p.mappedActorId)}`
          : "not yet mapped — ask which character is theirs";
      lines.push(`  - ${who} (${p.discordId}) → ${mapping}`);
    }

    if (characterActors.length > 0) {
      lines.push("");
      lines.push(
        "Player-character actors in the world (pass the actor id to record_player_character):",
      );
      for (const a of characterActors) {
        const claimedBy = ctx.presentPlayers.find((p) => p.mappedActorId === a.id);
        const status = claimedBy
          ? `claimed by ${claimedBy.displayName ?? claimedBy.discordId}`
          : mappedActorIds.has(a.id)
            ? "claimed"
            : "unclaimed";
        lines.push(`  - ${a.name} (actor id ${a.id}) — ${status}`);
      }
    }
  }

  if (ctx.retrievedMemory.length > 0) {
    lines.push("");
    lines.push("Relevant memory (retrieved):");
    for (const chunk of ctx.retrievedMemory) {
      lines.push(`  - (${chunk.kind}) ${chunk.text}`);
    }
  }

  if (ctx.recentDialogue.length > 0) {
    lines.push("");
    lines.push("Recent dialogue:");
    for (const turn of ctx.recentDialogue) {
      lines.push(`  ${formatSpeakerLine(turn)}`);
    }
  }

  return lines.join("\n");
}
