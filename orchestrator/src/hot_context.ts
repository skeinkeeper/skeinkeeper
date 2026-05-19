// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

/**
 * Hot tier of the four-tier memory model (ADR-0002). Assembles per-turn
 * prompt context from a warm-state snapshot and a dialogue history.
 *
 * Pure function. No DB reads. The caller (orchestrator) gathers the
 * snapshot from TenantDb and passes it in.
 */

export interface CharacterSnapshot {
  id: string;
  name: string;
  hp: number;
  maxHp: number;
  conditions: ReadonlyArray<string>;
}

export interface NpcSnapshot {
  id: string;
  name: string;
  mannerism?: string;
  motivation?: string;
  disposition: "friendly" | "neutral" | "hostile";
}

export interface LocationSnapshot {
  id: string;
  name: string;
  description?: string;
}

export interface CampaignSnapshot {
  id: string;
  name: string;
  rulesetId: string;
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
  party: ReadonlyArray<CharacterSnapshot>;
  currentLocation: LocationSnapshot | null;
  activeNpcs: ReadonlyArray<NpcSnapshot>;
}

export interface HotContextOptions {
  /** Number of most recent dialogue turns to include. Default 20. */
  windowSize?: number;
}

export interface HotContext {
  campaign: CampaignSnapshot;
  party: ReadonlyArray<CharacterSnapshot>;
  currentLocation: LocationSnapshot | null;
  activeNpcs: ReadonlyArray<NpcSnapshot>;
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

  return {
    campaign: warm.campaign,
    party: warm.party,
    currentLocation: warm.currentLocation,
    activeNpcs: warm.activeNpcs,
    recentDialogue,
  };
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
    lines.push("Current location: (unset)");
  }

  if (ctx.party.length > 0) {
    lines.push("");
    lines.push("Party:");
    for (const ch of ctx.party) {
      const conditions = ch.conditions.length > 0 ? ` [${ch.conditions.join(", ")}]` : "";
      lines.push(`  - ${ch.name}: HP ${ch.hp}/${ch.maxHp}${conditions}`);
    }
  }

  if (ctx.activeNpcs.length > 0) {
    lines.push("");
    lines.push("Active NPCs:");
    for (const npc of ctx.activeNpcs) {
      const parts = [`${npc.name} (${npc.disposition})`];
      if (npc.mannerism) parts.push(`mannerism: ${npc.mannerism}`);
      if (npc.motivation) parts.push(`wants: ${npc.motivation}`);
      lines.push(`  - ${parts.join("; ")}`);
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
