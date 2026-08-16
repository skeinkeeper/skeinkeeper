// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { z } from "zod";
import { defineTool, ToolRegistry, type AnyToolDefinition } from "../registry.js";
import { rollFormula } from "../dice.js";
import {
  distributeLootDef,
  hideTokenDef,
  placeHiddenTokenDef,
  revealTokenDef,
  shareJournalToAudienceDef,
} from "./triggered.js";

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
 *  - Player whisper: Foundry whisper via SurfaceRouter (TDD 0035).
 *  - Fudge: meta-mechanic, not system-specific.
 *  - Triggered play actions (TDD 0033): reveal/hide/place tokens, journal
 *    share, loot distribution.
 */

// ---- roll ----
const rollDef = defineTool({
  name: "roll",
  description:
    "Roll dice. The active Foundry system's roller handles formula interpretation and outcome — D&D 5e parses d20+modifier vs DC; Fate handles 4dF+skill; PbtA games handle 2d6+stat with 6-/7-9/10+ thresholds. Set secret=true for a hidden roll; pass audience { kind: player, playerId } to whisper the roll to one player, otherwise it is GM-only.",
  inputSchema: z.object({
    formula: z.string(),
    speaker: z.string().optional(),
    secret: z.boolean().optional(),
    audience: z
      .object({
        kind: z.enum(["table", "gm", "player"]),
        playerId: z.string().optional(),
      })
      .optional(),
  }),
  outputSchema: z.object({
    total: z.number(),
    rolls: z.array(z.number()),
    formula: z.string(),
    secret: z.boolean(),
    source: z.enum(["foundry", "local"]),
  }),
  async handle(input, ctx) {
    const secret = input.secret ?? false;
    let mode: "public" | "gm" | "blind" | "whisperTo" | undefined;
    let whisperTo: ReadonlyArray<string> | undefined;
    if (secret) {
      if (input.audience?.kind === "player") {
        const foundryUserId =
          input.audience.playerId !== undefined
            ? ctx.resolveFoundryUserId?.(input.audience.playerId)
            : undefined;
        if (foundryUserId === undefined) {
          ctx.analytics?.track("error.captured", {
            errorClass: "unresolved-foundry-user",
            module: "orchestrator:roll",
          });
          const local = rollFormula(input.formula);
          return {
            total: local.total,
            rolls: local.rolls,
            formula: input.formula,
            secret,
            source: "local" as const,
          };
        }
        mode = "whisperTo";
        whisperTo = [foundryUserId];
      } else {
        mode = "gm";
      }
    }
    // Prefer the active VTT's roller so dice land in Foundry's chat log. The
    // OSS bridge can't roll server-side yet (design doc 0014 mutation gap) and
    // throws, so fall back to the local crypto roller. Either way the result
    // has the same {total, rolls, formula} shape.
    if (ctx.foundry !== undefined) {
      try {
        const r = await ctx.foundry.rollDice(input.formula, {
          ...(input.speaker !== undefined ? { speaker: input.speaker } : {}),
          ...(mode !== undefined ? { mode } : {}),
          ...(whisperTo !== undefined ? { whisperTo } : {}),
        });
        return {
          total: r.total,
          rolls: [...r.rolls],
          formula: r.formula,
          secret,
          source: "foundry" as const,
        };
      } catch {
        ctx.analytics?.track("error.captured", {
          errorClass: "rollDice",
          module: "orchestrator:roll",
        });
      }
    }
    const local = rollFormula(input.formula);
    return {
      total: local.total,
      rolls: local.rolls,
      formula: input.formula,
      secret,
      source: "local" as const,
    };
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
    "Send a private Foundry whisper to one player. Use the player's Discord user id; the surface router resolves their Foundry user.",
  inputSchema: z.object({
    playerId: z.string(),
    text: z.string().min(1),
  }),
  outputSchema: z.object({ delivered: z.boolean() }),
  async handle(input, ctx) {
    if (ctx.surfaces !== undefined) {
      const report = await ctx.surfaces.emit({
        audience: { kind: "player", playerId: input.playerId },
        text: input.text,
      });
      return { delivered: report.perSurface.some((p) => p.status === "ok") };
    }
    if (ctx.whisperPlayer !== undefined) {
      await ctx.whisperPlayer(input.playerId, input.text);
      return { delivered: true };
    }
    return { delivered: false };
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
    foundryUserId: z.string().nullable(),
  }),
  async handle(input, ctx) {
    let foundryUserId: string | null = null;
    if (ctx.foundry !== undefined) {
      try {
        const users = await ctx.foundry.listUsers();
        const owningUser = users.find((u) =>
          (u.ownedActorIds ?? []).includes(input.foundryActorId),
        );
        foundryUserId = owningUser?.id ?? null;
      } catch {
        ctx.analytics?.track("error.captured", {
          errorClass: "listUsers",
          module: "orchestrator:record_player_character",
        });
      }
    }
    ctx.tenantDb.playerCharacterMap.record({
      campaignId: input.campaignId,
      discordUserId: input.discordUserId,
      foundryActorId: input.foundryActorId,
      ...(foundryUserId !== null ? { foundryUserId } : {}),
      ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
      source: "player",
      confirmedAt: Date.now(),
    });
    if (foundryUserId !== null) {
      ctx.identity?.bind(input.discordUserId, foundryUserId);
    } else if (ctx.surfaces !== undefined) {
      await ctx.surfaces.emit({
        audience: { kind: "gm" },
        text:
          `Recorded ${input.displayName ?? input.discordUserId} → ${input.foundryActorId}, ` +
          `but no Foundry user owns that actor. Add a Foundry user + grant ownership; ` +
          `then \`/skeinkeeper preflight verify @<player>\`.`,
        meta: { escalation: true, severity: "warning" },
      });
    }
    ctx.analytics?.track("identity.player_character.recorded", {
      source: "player",
      hasFoundryUser: foundryUserId !== null,
    });
    return {
      discordUserId: input.discordUserId,
      foundryActorId: input.foundryActorId,
      foundryUserId,
    };
  },
});

// ---- notify_operator ----
const notifyOperatorDef = defineTool({
  name: "notify_operator",
  description:
    "Privately message the human operator over Foundry GM chat about a setup problem you can't resolve in-fiction — e.g., a player named a character you can't find in Foundry, or Foundry seems disconnected. Players never see this. Use sparingly; never for normal play or narration.",
  inputSchema: z.object({
    message: z.string(),
    severity: z.enum(["info", "warning", "critical"]).optional(),
  }),
  outputSchema: z.object({ delivered: z.boolean() }),
  async handle(input, ctx) {
    const severity = input.severity ?? "info";
    ctx.analytics?.track("escalation.notify_operator", { severity });
    if (ctx.surfaces !== undefined) {
      try {
        const report = await ctx.surfaces.emit({
          audience: { kind: "gm" },
          text: input.message,
          meta: { escalation: true, severity },
        });
        const delivered = report.perSurface.some((p) => p.status === "ok");
        if (delivered && ctx.operatorFoundryUserKnown?.() !== true) {
          ctx.onOperatorEscalation?.({ message: input.message, severity });
        }
        return { delivered };
      } catch {
        return { delivered: false };
      }
    }
    if (ctx.notifyOperator === undefined) return { delivered: false };
    try {
      await ctx.notifyOperator(input.message);
      if (ctx.operatorFoundryUserKnown?.() !== true) {
        ctx.onOperatorEscalation?.({ message: input.message, severity });
      }
      return { delivered: true };
    } catch {
      return { delivered: false };
    }
  },
});

const resolveActionDef = defineTool({
  name: "resolve_action",
  description:
    "Commit a privately initiated in-scene action. The narration becomes table-visible (Foundry public chat and Discord voice). Call only when the action lands — never for private Q&A.",
  inputSchema: z.object({ narration: z.string().min(1) }),
  outputSchema: z.object({ resolved: z.boolean() }),
  async handle(input, ctx) {
    if (ctx.surfaces !== undefined) {
      await ctx.surfaces.emit({ audience: { kind: "table" }, text: input.narration });
    } else if (ctx.notifyTable !== undefined) {
      await ctx.notifyTable(input.narration);
    }
    return { resolved: true };
  },
});

export const BUILTIN_TOOLS: ReadonlyArray<AnyToolDefinition> = [
  rollDef,
  setQuestFlagDef,
  movePartyDef,
  advanceTimeDef,
  whisperDef,
  resolveActionDef,
  fudgeRollDef,
  recordPlayerCharacterDef,
  notifyOperatorDef,
  revealTokenDef,
  hideTokenDef,
  placeHiddenTokenDef,
  shareJournalToAudienceDef,
  distributeLootDef,
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
