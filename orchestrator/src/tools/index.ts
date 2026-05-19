// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { characters, npcs, questFlags } from "@skeinkeeper/server/schema";
import { defineTool, ToolRegistry, type AnyToolDefinition } from "../registry.js";
import { rollFormula } from "../dice.js";

// ---- roll ----
const rollDef = defineTool({
  name: "roll",
  description:
    "Roll dice. formula is NdM[+|-K] (e.g., '1d20+5'). secret=true means only the GM sees the dice.",
  inputSchema: z.object({
    formula: z.string(),
    advantage: z.boolean().optional(),
    disadvantage: z.boolean().optional(),
    secret: z.boolean().optional(),
  }),
  outputSchema: z.object({
    total: z.number(),
    dice: z.array(z.number()),
    formula: z.string(),
    modifier: z.number(),
    advantage: z.boolean(),
    secret: z.boolean(),
  }),
  async handle(input) {
    const opts: { advantage?: boolean; disadvantage?: boolean } = {};
    if (input.advantage !== undefined) opts.advantage = input.advantage;
    if (input.disadvantage !== undefined) opts.disadvantage = input.disadvantage;
    const result = rollFormula(input.formula, opts);
    return { ...result, secret: input.secret ?? false };
  },
});

// ---- apply_damage ----
const damageInput = z.object({
  characterId: z.string(),
  amount: z.number().int().nonnegative(),
  source: z.string().optional(),
});
const damageOutput = z.object({
  characterId: z.string(),
  before: z.number(),
  after: z.number(),
});

const applyDamageDef = defineTool({
  name: "apply_damage",
  description: "Reduce a character's HP by amount (clamped at 0).",
  inputSchema: damageInput,
  outputSchema: damageOutput,
  async handle(input, ctx) {
    const ch = ctx.tenantDb.characters.get(input.characterId);
    if (!ch) throw new Error(`Character ${input.characterId} not found`);
    const after = Math.max(0, ch.hp - input.amount);
    ctx.tenantDb.unsafelyAcrossTenants((db) =>
      db
        .update(characters)
        .set({ hp: after, updatedAt: Date.now() })
        .where(and(eq(characters.tenantId, ctx.tenantDb.tenantId), eq(characters.id, input.characterId)))
        .run(),
    );
    return { characterId: input.characterId, before: ch.hp, after };
  },
});

// ---- heal ----
const healDef = defineTool({
  name: "heal",
  description: "Restore a character's HP by amount (capped at maxHp).",
  inputSchema: damageInput,
  outputSchema: damageOutput,
  async handle(input, ctx) {
    const ch = ctx.tenantDb.characters.get(input.characterId);
    if (!ch) throw new Error(`Character ${input.characterId} not found`);
    const after = Math.min(ch.maxHp, ch.hp + input.amount);
    ctx.tenantDb.unsafelyAcrossTenants((db) =>
      db
        .update(characters)
        .set({ hp: after, updatedAt: Date.now() })
        .where(and(eq(characters.tenantId, ctx.tenantDb.tenantId), eq(characters.id, input.characterId)))
        .run(),
    );
    return { characterId: input.characterId, before: ch.hp, after };
  },
});

// ---- conditions ----
const conditionInput = z.object({ characterId: z.string(), condition: z.string() });
const conditionOutput = z.object({ characterId: z.string(), conditions: z.array(z.string()) });

function withConditions(ch: { rulesetDataJson: string }, mutator: (conds: string[]) => string[]): string {
  const data: Record<string, unknown> = JSON.parse(ch.rulesetDataJson || "{}");
  const current = Array.isArray(data.conditions) ? (data.conditions as string[]) : [];
  data.conditions = mutator(current);
  return JSON.stringify(data);
}

const setConditionDef = defineTool({
  name: "set_condition",
  description: "Add a named condition to a character (e.g., 'frightened').",
  inputSchema: conditionInput,
  outputSchema: conditionOutput,
  async handle(input, ctx) {
    const ch = ctx.tenantDb.characters.get(input.characterId);
    if (!ch) throw new Error(`Character ${input.characterId} not found`);
    const next = withConditions(ch, (cs) => (cs.includes(input.condition) ? cs : [...cs, input.condition]));
    ctx.tenantDb.unsafelyAcrossTenants((db) =>
      db
        .update(characters)
        .set({ rulesetDataJson: next, updatedAt: Date.now() })
        .where(and(eq(characters.tenantId, ctx.tenantDb.tenantId), eq(characters.id, input.characterId)))
        .run(),
    );
    return {
      characterId: input.characterId,
      conditions: (JSON.parse(next) as { conditions: string[] }).conditions,
    };
  },
});

const clearConditionDef = defineTool({
  name: "clear_condition",
  description: "Remove a named condition from a character.",
  inputSchema: conditionInput,
  outputSchema: conditionOutput,
  async handle(input, ctx) {
    const ch = ctx.tenantDb.characters.get(input.characterId);
    if (!ch) throw new Error(`Character ${input.characterId} not found`);
    const next = withConditions(ch, (cs) => cs.filter((c) => c !== input.condition));
    ctx.tenantDb.unsafelyAcrossTenants((db) =>
      db
        .update(characters)
        .set({ rulesetDataJson: next, updatedAt: Date.now() })
        .where(and(eq(characters.tenantId, ctx.tenantDb.tenantId), eq(characters.id, input.characterId)))
        .run(),
    );
    return {
      characterId: input.characterId,
      conditions: (JSON.parse(next) as { conditions: string[] }).conditions,
    };
  },
});

// ---- update_inventory ----
const updateInventoryDef = defineTool({
  name: "update_inventory",
  description: "Change an inventory item's count by delta (negative to remove). Removes the entry at 0.",
  inputSchema: z.object({
    characterId: z.string(),
    item: z.string(),
    delta: z.number().int(),
  }),
  outputSchema: z.object({
    characterId: z.string(),
    item: z.string(),
    before: z.number(),
    after: z.number(),
  }),
  async handle(input, ctx) {
    const ch = ctx.tenantDb.characters.get(input.characterId);
    if (!ch) throw new Error(`Character ${input.characterId} not found`);
    const data: Record<string, unknown> = JSON.parse(ch.rulesetDataJson || "{}");
    const inv = (data.inventory as Record<string, number> | undefined) ?? {};
    const before = inv[input.item] ?? 0;
    const after = Math.max(0, before + input.delta);
    if (after === 0) delete inv[input.item];
    else inv[input.item] = after;
    data.inventory = inv;
    const next = JSON.stringify(data);
    ctx.tenantDb.unsafelyAcrossTenants((db) =>
      db
        .update(characters)
        .set({ rulesetDataJson: next, updatedAt: Date.now() })
        .where(and(eq(characters.tenantId, ctx.tenantDb.tenantId), eq(characters.id, input.characterId)))
        .run(),
    );
    return { characterId: input.characterId, item: input.item, before, after };
  },
});

// ---- set_quest_flag ----
const setQuestFlagDef = defineTool({
  name: "set_quest_flag",
  description: "Set a campaign quest flag by string key. Replaces any existing value.",
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
  description: "Move the party to a new location. Records as quest flag 'party.location'.",
  inputSchema: z.object({
    campaignId: z.string(),
    locationId: z.string(),
  }),
  outputSchema: z.object({
    campaignId: z.string(),
    locationId: z.string(),
  }),
  async handle(input, ctx) {
    ctx.tenantDb.questFlags.set({
      campaignId: input.campaignId,
      key: "party.location",
      value: input.locationId,
      updatedAt: Date.now(),
    });
    return input;
  },
});

// ---- update_npc_disposition ----
const updateNpcDispositionDef = defineTool({
  name: "update_npc_disposition",
  description: "Set an NPC's disposition toward the party.",
  inputSchema: z.object({
    npcId: z.string(),
    disposition: z.enum(["friendly", "neutral", "hostile"]),
  }),
  outputSchema: z.object({
    npcId: z.string(),
    disposition: z.enum(["friendly", "neutral", "hostile"]),
  }),
  async handle(input, ctx) {
    ctx.tenantDb.unsafelyAcrossTenants((db) =>
      db
        .update(npcs)
        .set({ disposition: input.disposition, updatedAt: Date.now() })
        .where(and(eq(npcs.tenantId, ctx.tenantDb.tenantId), eq(npcs.id, input.npcId)))
        .run(),
    );
    return input;
  },
});

// ---- advance_time ----
const advanceTimeDef = defineTool({
  name: "advance_time",
  description:
    "Advance in-game time by the given number of minutes. Increments quest flag 'time.minutes_elapsed'.",
  inputSchema: z.object({
    campaignId: z.string(),
    minutes: z.number().int().nonnegative(),
  }),
  outputSchema: z.object({
    campaignId: z.string(),
    minutesElapsed: z.number(),
  }),
  async handle(input, ctx) {
    const existing = ctx.tenantDb.unsafelyAcrossTenants((db) =>
      db
        .select()
        .from(questFlags)
        .where(
          and(
            eq(questFlags.tenantId, ctx.tenantDb.tenantId),
            eq(questFlags.campaignId, input.campaignId),
            eq(questFlags.key, "time.minutes_elapsed"),
          ),
        )
        .get(),
    );
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
  description: "Send a private message to one player. The voice plugin picks this up from the audit log.",
  inputSchema: z.object({
    targetPlayerDiscordId: z.string(),
    content: z.string().min(1),
  }),
  outputSchema: z.object({ delivered: z.boolean() }),
  async handle() {
    return { delivered: true };
  },
});

// ---- fudge_roll (operator-gated) ----
const fudgeRollDef = defineTool({
  name: "fudge_roll",
  description:
    "Override the mechanical outcome of a previous secret roll. Operator-gated; the LLM may not call this unless the orchestrator has flipped the per-session fudge flag.",
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

export const BUILTIN_TOOLS: ReadonlyArray<AnyToolDefinition> = [
  rollDef,
  applyDamageDef,
  healDef,
  setConditionDef,
  clearConditionDef,
  updateInventoryDef,
  setQuestFlagDef,
  movePartyDef,
  updateNpcDispositionDef,
  advanceTimeDef,
  whisperDef,
  fudgeRollDef,
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
