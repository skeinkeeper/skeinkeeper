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

import type { FoundryActor } from "./foundry/client.js";
import { renderActorState } from "./foundry/render.js";

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
}

export interface WarmStateSnapshot {
  campaign: CampaignSnapshot;
  party: ReadonlyArray<FoundryActor>;
  activeNpcs: ReadonlyArray<FoundryActor>;
  currentLocation: LocationSnapshot | null;
}

export interface HotContextOptions {
  /** Number of most recent dialogue turns to include. Default 20. */
  windowSize?: number;
}

export interface HotContext extends WarmStateSnapshot {
  recentDialogue: ReadonlyArray<DialogueTurn>;
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

  return { ...warm, recentDialogue };
}

/**
 * Render the hot context as a plain-text block suitable for injection
 * into a system prompt. The LLM provider (Phase 1.5) decides whether
 * to embed it as a system message or as the leading user message.
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

  if (ctx.recentDialogue.length > 0) {
    lines.push("");
    lines.push("Recent dialogue:");
    for (const turn of ctx.recentDialogue) {
      const who = turn.displayName ?? turn.speaker;
      lines.push(`  [${who}] ${turn.text}`);
    }
  }

  return lines.join("\n");
}
