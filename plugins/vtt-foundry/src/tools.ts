// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { z } from "zod";
import {
  defineTool,
  type AnyToolDefinition,
  type FoundryClient,
  type ToolHandlerContext,
  type ToolRegistry,
} from "@skeinkeeper/orchestrator";

/**
 * dnd5e mechanical-write tool wrappers (TDD 0042). These register through
 * TDD 0006's registry at session start, once the connected world's system is
 * known — dnd5e is the validated system (ADR-0012). All mutation goes through
 * the typed FoundryClient methods, never free text (ADR-0003). Tool-call
 * telemetry fires from the dispatcher; no per-tool events here.
 */

export class FoundryWriteToolError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "FoundryWriteToolError";
    this.code = code;
  }
}

function requireFoundry(ctx: ToolHandlerContext): FoundryClient {
  if (ctx.foundry === undefined) {
    throw new FoundryWriteToolError("foundry-unavailable", "no Foundry client on this turn");
  }
  return ctx.foundry;
}

/** Preserve the add-on/mock error code (bad-args, not-found, timeout, …)
 *  instead of collapsing everything into one wrapper code. */
function rethrow(err: unknown): never {
  if (err instanceof FoundryWriteToolError) throw err;
  const code =
    err !== null && typeof err === "object" && typeof (err as { code?: unknown }).code === "string"
      ? (err as { code: string }).code
      : "foundry-write-failed";
  throw new FoundryWriteToolError(code, err instanceof Error ? err.message : String(err));
}

const combatSnapshotSchema = z.object({
  combatId: z.string().nullable(),
  round: z.number(),
  turn: z.number(),
  currentCombatantId: z.string().nullable(),
});

const hpResultSchema = z.object({
  hp: z.number(),
  tempHp: z.number().optional(),
});

const applyDamageDef = defineTool({
  name: "apply_damage",
  description:
    "Apply damage to an actor's hit points on their Foundry sheet. dnd5e handles temp HP, resistances, and death saves. Returns the remaining HP. Use the heal tool to restore HP.",
  mutatesWorld: true,
  inputSchema: z.object({
    actorId: z.string().min(1),
    amount: z.number().finite().positive(),
  }),
  outputSchema: hpResultSchema,
  async handle(input, ctx) {
    try {
      return await requireFoundry(ctx).applyDamage({
        actorId: input.actorId,
        amount: input.amount,
      });
    } catch (err) {
      rethrow(err);
    }
  },
});

const healDef = defineTool({
  name: "heal",
  description:
    "Restore hit points to an actor on their Foundry sheet, capped at their HP maximum. Returns the resulting HP.",
  mutatesWorld: true,
  inputSchema: z.object({
    actorId: z.string().min(1),
    amount: z.number().finite().positive(),
  }),
  outputSchema: hpResultSchema,
  async handle(input, ctx) {
    try {
      // Heal is damage with the sign flipped (TDD 0042); the client caps at max.
      return await requireFoundry(ctx).applyDamage({
        actorId: input.actorId,
        amount: -input.amount,
      });
    } catch (err) {
      rethrow(err);
    }
  },
});

const startCombatDef = defineTool({
  name: "start_combat",
  description:
    "Start a combat encounter in the Foundry combat tracker. Omit combatantIds to enroll every token on the active scene; pass token or actor ids to enroll only those. If combat is already running, returns the existing encounter.",
  mutatesWorld: true,
  inputSchema: z.object({
    combatantIds: z.array(z.string().min(1)).optional(),
  }),
  outputSchema: combatSnapshotSchema,
  async handle(input, ctx) {
    try {
      return await requireFoundry(ctx).manageCombat({
        action: "start",
        ...(input.combatantIds !== undefined ? { combatantIds: input.combatantIds } : {}),
      });
    } catch (err) {
      rethrow(err);
    }
  },
});

const endCombatDef = defineTool({
  name: "end_combat",
  description:
    "End the current combat encounter and clear the Foundry combat tracker. Succeeds even if no combat is running (combatId is null in that case).",
  mutatesWorld: true,
  inputSchema: z.object({}),
  outputSchema: combatSnapshotSchema,
  async handle(_input, ctx) {
    try {
      return await requireFoundry(ctx).manageCombat({ action: "end" });
    } catch (err) {
      rethrow(err);
    }
  },
});

const nextTurnDef = defineTool({
  name: "next_turn",
  description:
    "Advance the Foundry combat tracker to the next turn. Returns the new round, turn, and current combatant. Succeeds with combatId null if no combat is running.",
  mutatesWorld: true,
  inputSchema: z.object({}),
  outputSchema: combatSnapshotSchema,
  async handle(_input, ctx) {
    try {
      return await requireFoundry(ctx).manageCombat({ action: "next-turn" });
    } catch (err) {
      rethrow(err);
    }
  },
});

const spawnTokenDef = defineTool({
  name: "spawn_token",
  description:
    "Place a token for an actor on a scene at x/y in scene PIXELS (not grid squares; multiply grid position by the scene's grid size). Provide actorId for a world actor, or compendiumRef ('pack.entry') to import first. Set hidden true to place it invisible to players.",
  mutatesWorld: true,
  inputSchema: z
    .object({
      actorId: z.string().min(1).optional(),
      compendiumRef: z.string().min(1).optional(),
      sceneId: z.string().min(1).optional(),
      x: z.number().finite(),
      y: z.number().finite(),
      hidden: z.boolean().optional(),
    })
    .refine((v) => v.actorId !== undefined || v.compendiumRef !== undefined, {
      message: "actorId or compendiumRef required",
    }),
  outputSchema: z.object({ tokenId: z.string(), actorId: z.string() }),
  async handle(input, ctx) {
    try {
      return await requireFoundry(ctx).createToken({
        x: input.x,
        y: input.y,
        ...(input.actorId !== undefined ? { actorId: input.actorId } : {}),
        ...(input.compendiumRef !== undefined ? { compendiumRef: input.compendiumRef } : {}),
        ...(input.sceneId !== undefined ? { sceneId: input.sceneId } : {}),
        ...(input.hidden !== undefined ? { hidden: input.hidden } : {}),
      });
    } catch (err) {
      rethrow(err);
    }
  },
});

const revealFogDef = defineTool({
  name: "reveal_fog",
  description:
    "Lift the fog of war so players can see the whole scene (core Foundry fog). Defaults to the active scene.",
  mutatesWorld: true,
  inputSchema: z.object({ sceneId: z.string().min(1).optional() }),
  outputSchema: z.object({ sceneId: z.string() }),
  async handle(input, ctx) {
    try {
      return await requireFoundry(ctx).manageFog({
        action: "reveal-scene",
        ...(input.sceneId !== undefined ? { sceneId: input.sceneId } : {}),
      });
    } catch (err) {
      rethrow(err);
    }
  },
});

const resetFogDef = defineTool({
  name: "reset_fog",
  description:
    "Reset the fog of war on a scene: fog covers the map again and players' explored areas are cleared. Defaults to the active scene.",
  mutatesWorld: true,
  inputSchema: z.object({ sceneId: z.string().min(1).optional() }),
  outputSchema: z.object({ sceneId: z.string() }),
  async handle(input, ctx) {
    try {
      return await requireFoundry(ctx).manageFog({
        action: "reset",
        ...(input.sceneId !== undefined ? { sceneId: input.sceneId } : {}),
      });
    } catch (err) {
      rethrow(err);
    }
  },
});

export const DND5E_WRITE_TOOLS: ReadonlyArray<AnyToolDefinition> = [
  applyDamageDef,
  healDef,
  startCombatDef,
  endCombatDef,
  nextTurnDef,
  spawnTokenDef,
  revealFogDef,
  resetFogDef,
];

/**
 * Register the system-scoped mechanical-write tools for the connected world.
 * Call at session start once `FoundryClient.system` is known. Only dnd5e is
 * validated (ADR-0012); other systems get no write wrappers and the AI falls
 * back to narration plus the system-agnostic core tools.
 */
export function registerFoundrySystemTools(registry: ToolRegistry, system: string): void {
  if (system !== "dnd5e") return;
  for (const tool of DND5E_WRITE_TOOLS) {
    registry.register(tool);
  }
}
