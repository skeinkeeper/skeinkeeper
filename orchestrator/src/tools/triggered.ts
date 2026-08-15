// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { z } from "zod";
import type { AnalyticsClient } from "@skeinkeeper/telemetry";
import type { FoundryClient } from "../foundry/client.js";
import { defineTool, type ToolHandlerContext } from "../registry.js";

export class TriggeredActionError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "TriggeredActionError";
    this.code = code;
  }
}

export function requireFoundry(ctx: ToolHandlerContext): FoundryClient {
  if (ctx.foundry === undefined) {
    throw new TriggeredActionError("foundry-unavailable", "no Foundry client on this turn");
  }
  return ctx.foundry;
}

export function campaignIdOf(ctx: ToolHandlerContext): string {
  return ctx.campaignId ?? ctx.tenantDb.sessions.get(ctx.sessionId)?.campaignId ?? "unknown";
}

export function trackAction(
  ctx: ToolHandlerContext,
  name: keyof import("@skeinkeeper/telemetry").Events,
  props: Record<string, unknown>,
): void {
  const analytics: AnalyticsClient | undefined = ctx.analytics;
  analytics?.track(name, props as never);
}

export const revealTokenDef = defineTool({
  name: "reveal_token",
  description: "Reveal an existing hidden token to the table (Foundry token hidden flag → false).",
  mutatesWorld: true,
  inputSchema: z.object({ tokenId: z.string().min(1) }),
  outputSchema: z.object({ tokenId: z.string(), hidden: z.literal(false) }),
  async handle(input, ctx) {
    const campaignId = campaignIdOf(ctx);
    try {
      const foundry = requireFoundry(ctx);
      await foundry.updateToken({ tokenId: input.tokenId, hidden: false });
      trackAction(ctx, "action.reveal_token", { campaignId, success: true });
      return { tokenId: input.tokenId, hidden: false as const };
    } catch (err) {
      trackAction(ctx, "action.reveal_token", { campaignId, success: false });
      if (err instanceof TriggeredActionError) throw err;
      throw new TriggeredActionError(
        "token-update-failed",
        err instanceof Error ? err.message : String(err),
      );
    }
  },
});

const lootItemSchema = z.object({
  compendiumId: z.string().optional(),
  itemId: z.string().optional(),
  quantity: z.number().int().positive(),
});

export const distributeLootDef = defineTool({
  name: "distribute_loot",
  description:
    "Distribute items from the compendium (or by template id) to one or more party actors. Non-party recipients are rejected; a failure on one item does not roll back earlier items.",
  mutatesWorld: true,
  inputSchema: z.object({
    distributions: z
      .array(
        z.object({
          actorId: z.string().min(1),
          items: z.array(lootItemSchema).min(1),
        }),
      )
      .min(1),
  }),
  outputSchema: z.object({
    partialFailure: z.boolean(),
    items: z.array(
      z.object({
        actorId: z.string(),
        itemId: z.string().optional(),
        compendiumId: z.string().optional(),
        quantity: z.number(),
        ok: z.boolean(),
        error: z.string().optional(),
      }),
    ),
  }),
  async handle(input, ctx) {
    const campaignId = campaignIdOf(ctx);
    const foundry = requireFoundry(ctx);
    const party = new Set((await foundry.listPartyActors()).map((a) => a.id));
    const rejectedActors = new Set(
      input.distributions.filter((d) => !party.has(d.actorId)).map((d) => d.actorId),
    );

    const items: Array<{
      actorId: string;
      itemId?: string;
      compendiumId?: string;
      quantity: number;
      ok: boolean;
      error?: string;
    }> = [];

    if (rejectedActors.size > 0) {
      for (const dist of input.distributions) {
        const error = rejectedActors.has(dist.actorId)
          ? "not-party-actor"
          : "batch-rejected-non-party";
        for (const item of dist.items) {
          items.push({
            actorId: dist.actorId,
            ...(item.itemId !== undefined ? { itemId: item.itemId } : {}),
            ...(item.compendiumId !== undefined ? { compendiumId: item.compendiumId } : {}),
            quantity: item.quantity,
            ok: false,
            error,
          });
        }
      }
      trackAction(ctx, "action.distribute_loot", {
        campaignId,
        recipientCount: input.distributions.length,
        itemCount: items.length,
        partialFailure: true,
      });
      return { partialFailure: true, items };
    }

    for (const dist of input.distributions) {
      for (const item of dist.items) {
        try {
          await foundry.addActorItems({ actorId: dist.actorId, items: [item] });
          items.push({
            actorId: dist.actorId,
            ...(item.itemId !== undefined ? { itemId: item.itemId } : {}),
            ...(item.compendiumId !== undefined ? { compendiumId: item.compendiumId } : {}),
            quantity: item.quantity,
            ok: true,
          });
        } catch (err) {
          items.push({
            actorId: dist.actorId,
            ...(item.itemId !== undefined ? { itemId: item.itemId } : {}),
            ...(item.compendiumId !== undefined ? { compendiumId: item.compendiumId } : {}),
            quantity: item.quantity,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    const partialFailure = items.some((i) => !i.ok);
    trackAction(ctx, "action.distribute_loot", {
      campaignId,
      recipientCount: input.distributions.length,
      itemCount: items.length,
      partialFailure,
    });
    return { partialFailure, items };
  },
});

export const hideTokenDef = defineTool({
  name: "hide_token",
  description: "Hide an existing visible token (Foundry token hidden flag → true).",
  mutatesWorld: true,
  inputSchema: z.object({ tokenId: z.string().min(1) }),
  outputSchema: z.object({ tokenId: z.string(), hidden: z.literal(true) }),
  async handle(input, ctx) {
    const campaignId = campaignIdOf(ctx);
    try {
      const foundry = requireFoundry(ctx);
      await foundry.updateToken({ tokenId: input.tokenId, hidden: true });
      trackAction(ctx, "action.hide_token", { campaignId, success: true });
      return { tokenId: input.tokenId, hidden: true as const };
    } catch (err) {
      trackAction(ctx, "action.hide_token", { campaignId, success: false });
      if (err instanceof TriggeredActionError) throw err;
      throw new TriggeredActionError(
        "token-update-failed",
        err instanceof Error ? err.message : String(err),
      );
    }
  },
});
