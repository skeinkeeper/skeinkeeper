// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { z } from "zod";
import { defineTool, ToolRegistry, type AnyToolDefinition } from "../registry.js";
import { rollFormula } from "../dice.js";

/**
 * Core tools — system-agnostic, owned by Skeinkeeper. Per design doc
 * 0007, system-specific mutation tools (apply_damage, heal,
 * set_condition for D&D; apply_stress, take_consequence for Fate;
 * apply_harm, tick_harm_clock for PbtA) are planned to be registered by
 * the Foundry plugin at session start — not yet wired (the OSS bridge
 * mutation gap, design doc 0014).
 *
 * The tools here are universal:
 *  - Dice: tries FoundryClient.rollDice() so rolls land in Foundry's chat
 *    log, falling back to the local crypto roller when the bridge can't
 *    roll server-side (design doc 0014).
 *  - World state: quest flags, party movement, in-game time.
 *  - Player whisper: Discord side, not VTT side.
 *  - Fudge: meta-mechanic, not system-specific.
 */

// ---- roll ----
const rollDef = defineTool({
  name: "roll",
  description:
    "Roll dice. The active Foundry system's roller handles formula interpretation and outcome — D&D 5e parses d20+modifier vs DC; Fate handles 4dF+skill; PbtA games handle 2d6+stat with 6-/7-9/10+ thresholds. Set secret=true for GM-only rolls.",
  inputSchema: z.object({
    formula: z.string(),
    speaker: z.string().optional(),
    secret: z.boolean().optional(),
  }),
  outputSchema: z.object({
    total: z.number(),
    rolls: z.array(z.number()),
    formula: z.string(),
    secret: z.boolean(),
  }),
  async handle(input, ctx) {
    const secret = input.secret ?? false;
    // Prefer the active VTT's roller so dice land in Foundry's chat log. The
    // OSS bridge can't roll server-side yet (design doc 0014 mutation gap) and
    // throws, so fall back to the local crypto roller. Either way the result
    // has the same {total, rolls, formula} shape.
    if (ctx.foundry !== undefined) {
      try {
        const r = await ctx.foundry.rollDice(
          input.formula,
          input.speaker !== undefined ? { speaker: input.speaker } : undefined,
        );
        return { total: r.total, rolls: [...r.rolls], formula: r.formula, secret };
      } catch {
        // fall through to the local roller
      }
    }
    const local = rollFormula(input.formula);
    return { total: local.total, rolls: local.rolls, formula: input.formula, secret };
  },
});

// ---- set_quest_flag ----
const setQuestFlagDef = defineTool({
  name: "set_quest_flag",
  description:
    "Set a Skeinkeeper-internal quest flag by string key. AI-DM-side state, distinct from Foundry's world state.",
  mutatesWorld: true,
  inputSchema: z.object({
    campaignId: z.string(),
    key: z.string().min(1),
    value: z.string(),
  }),
  outputSchema: z.object({
    campaignId: z.string(),
    key: z.string(),
    value: z.string(),
  }),
  async handle(input, ctx) {
    ctx.tenantDb.questFlags.set({
      campaignId: input.campaignId,
      key: input.key,
      value: input.value,
      updatedAt: Date.now(),
    });
    return input;
  },
});

// ---- move_party ----
const movePartyDef = defineTool({
  name: "move_party",
  description:
    "Move the party to a new location, given a Foundry scene name or ID. Activates that scene in Foundry (the map players see) and records it as the 'party.location' quest flag. Use the scene name as it appears in the world.",
  mutatesWorld: true,
  inputSchema: z.object({
    campaignId: z.string(),
    locationId: z.string(),
  }),
  outputSchema: z.object({
    campaignId: z.string(),
    locationId: z.string(),
    sceneActivated: z.boolean(),
  }),
  async handle(input, ctx) {
    ctx.tenantDb.questFlags.set({
      campaignId: input.campaignId,
      key: "party.location",
      value: input.locationId,
      updatedAt: Date.now(),
    });
    // Activating the map is an in-play DM action (ADR-0015) — the AI does it,
    // never the operator. Best-effort: the quest flag is still recorded even if
    // the VTT call fails.
    let sceneActivated = false;
    if (ctx.foundry !== undefined) {
      try {
        await ctx.foundry.setActiveScene(input.locationId);
        sceneActivated = true;
      } catch {
        // scene name may not match a world scene; leave flag set, report false
      }
    }
    return { ...input, sceneActivated };
  },
});

// ---- advance_time ----
const advanceTimeDef = defineTool({
  name: "advance_time",
  description:
    "Advance in-game time by the given number of minutes. Increments the 'time.minutes_elapsed' quest flag. The active Foundry system may have its own time-tracking; this is the Skeinkeeper-side counter for AI awareness.",
  mutatesWorld: true,
  inputSchema: z.object({
    campaignId: z.string(),
    minutes: z.number().int().nonnegative(),
  }),
  outputSchema: z.object({
    campaignId: z.string(),
    minutesElapsed: z.number(),
  }),
  async handle(input, ctx) {
    const existing = ctx.tenantDb.questFlags
      .listByCampaign(input.campaignId)
      .find((f) => f.key === "time.minutes_elapsed");
    const current = existing ? Number.parseInt(existing.value, 10) || 0 : 0;
    const next = current + input.minutes;
    ctx.tenantDb.questFlags.set({
      campaignId: input.campaignId,
      key: "time.minutes_elapsed",
      value: String(next),
      updatedAt: Date.now(),
    });
    return { campaignId: input.campaignId, minutesElapsed: next };
  },
});

// ---- whisper ----
const whisperDef = defineTool({
  name: "whisper",
  description:
    "Send a private message to one player via Discord. The voice plugin picks this up from the audit log.",
  inputSchema: z.object({
    targetPlayerDiscordId: z.string(),
    content: z.string().min(1),
  }),
  outputSchema: z.object({ delivered: z.boolean() }),
  async handle() {
    return { delivered: true };
  },
});

// ---- fudge_roll ----
const fudgeRollDef = defineTool({
  name: "fudge_roll",
  description:
    "Override the mechanical outcome of a previous secret roll. Operator-gated; the LLM may not call this unless the orchestrator has flipped the per-session fudge flag. See behavior/default.md §5.4.",
  inputSchema: z.object({
    originalTotal: z.number(),
    newTotal: z.number(),
    reason: z.string().min(10),
  }),
  outputSchema: z.object({ accepted: z.boolean() }),
  operatorGated: true,
  async handle() {
    return { accepted: true };
  },
});

// ---- record_player_character ----
const recordPlayerCharacterDef = defineTool({
  name: "record_player_character",
  description:
    "Record which Foundry character a Discord player controls. Call this during the session-start introductions once a player names their character and you've matched it to an actor in the party. Confirm aloud to the player afterward.",
  mutatesWorld: true,
  inputSchema: z.object({
    campaignId: z.string(),
    discordUserId: z.string(),
    foundryActorId: z.string(),
    displayName: z.string().optional(),
  }),
  outputSchema: z.object({
    discordUserId: z.string(),
    foundryActorId: z.string(),
  }),
  async handle(input, ctx) {
    ctx.tenantDb.playerCharacterMap.record({
      campaignId: input.campaignId,
      discordUserId: input.discordUserId,
      foundryActorId: input.foundryActorId,
      ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
      source: "player",
      confirmedAt: Date.now(),
    });
    return { discordUserId: input.discordUserId, foundryActorId: input.foundryActorId };
  },
});

// ---- notify_operator ----
const notifyOperatorDef = defineTool({
  name: "notify_operator",
  description:
    "Privately message the human operator over Discord DM about a setup problem you can't resolve in-fiction — e.g., a player named a character you can't find in Foundry, or Foundry seems disconnected. Players never see this. Use sparingly; never for normal play or narration.",
  inputSchema: z.object({ message: z.string() }),
  outputSchema: z.object({ delivered: z.boolean() }),
  async handle(input, ctx) {
    if (ctx.notifyOperator === undefined) return { delivered: false };
    try {
      await ctx.notifyOperator(input.message);
      return { delivered: true };
    } catch {
      return { delivered: false };
    }
  },
});

export const BUILTIN_TOOLS: ReadonlyArray<AnyToolDefinition> = [
  rollDef,
  setQuestFlagDef,
  movePartyDef,
  advanceTimeDef,
  whisperDef,
  fudgeRollDef,
  recordPlayerCharacterDef,
  notifyOperatorDef,
];

export function registerBuiltinTools(registry: ToolRegistry): void {
  for (const tool of BUILTIN_TOOLS) {
    registry.register(tool);
  }
}

export function createDefaultRegistry(): ToolRegistry {
  const r = new ToolRegistry();
  registerBuiltinTools(r);
  return r;
}
