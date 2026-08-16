// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { z } from "zod";
import { TABLE_AUDIENCE, TABLE_CONVERSATION, type Audience } from "@skeinkeeper/server";
import type { AnalyticsClient } from "@skeinkeeper/telemetry";
import type { FoundryActor, FoundryClient } from "../foundry/client.js";
import { parseCompendiumRef } from "../foundry/client.js";
import { defineTool, type ToolHandlerContext } from "../registry.js";

export const JOURNAL_EXCERPT_DEFAULT = 1500;
const PLAYER_NOTE_PREFIX = "*A note slips into your hand:*";

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
          await foundry.addActorItems({ actorId: dist.actorId, items: [lootItem(item)] });
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

const DISPOSITION = ["hostile", "neutral", "friendly"] as const;

export const placeHiddenTokenDef = defineTool({
  name: "place_hidden_token",
  description:
    "Place a creature/NPC on the active scene with a hidden token. Resolves a world actor or imports from compendium, then places at pixel coordinates (not grid indexes).",
  mutatesWorld: true,
  inputSchema: z.object({
    actorRef: z
      .object({
        compendiumId: z.string().optional(),
        actorId: z.string().optional(),
        namePack: z.string().optional(),
      })
      .refine(
        (r) => r.compendiumId !== undefined || r.actorId !== undefined || r.namePack !== undefined,
        { message: "actorRef requires actorId, compendiumId, or namePack" },
      ),
    sceneId: z.string().min(1),
    coords: z.object({ x: z.number(), y: z.number() }).optional(),
    disposition: z.enum(DISPOSITION).optional(),
  }),
  outputSchema: z.object({ tokenId: z.string() }),
  async handle(input, ctx) {
    const campaignId = campaignIdOf(ctx);
    const actorRefKind = actorRefKindOf(compactActorRef(input.actorRef));
    const sceneId = input.sceneId;
    const emit = (success: boolean) =>
      trackAction(ctx, "action.place_hidden_token", { campaignId, sceneId, actorRefKind, success });
    try {
      const foundry = requireFoundry(ctx);
      const active = await foundry.getActiveScene();
      if (active === null || active.id !== input.sceneId) {
        throw new TriggeredActionError(
          "scene-changed-mid-action",
          "active scene does not match the requested sceneId",
        );
      }
      const actorId = await resolveActorId(foundry, compactActorRef(input.actorRef));
      const x = input.coords?.x ?? 0;
      const y = input.coords?.y ?? 0;
      let tokenId = "";
      try {
        const placed = await foundry.createToken({
          actorId,
          sceneId: input.sceneId,
          x,
          y,
          hidden: true,
          ...(input.disposition !== undefined ? { disposition: input.disposition } : {}),
        });
        tokenId = placed.tokenId;
      } catch {
        tokenId = "";
      }
      let details = tokenId.length > 0 ? await foundry.getTokenDetails(tokenId) : null;
      if (details === null) {
        const latest = await foundry.getActiveScene();
        const token = latest?.tokens.find((t) => t.actorId === actorId && t.id !== undefined);
        if (token?.id !== undefined) {
          tokenId = token.id;
          details = await foundry.getTokenDetails(tokenId);
        }
      }
      if (details === null || tokenId.length === 0) {
        await ctx.notifyOperator?.(
          "place_hidden_token failed: bridge-coverage-gap — actor created but no token spawned.",
        );
        throw new TriggeredActionError(
          "bridge-coverage-gap",
          "create-actor-from-compendium returned no token",
        );
      }
      if (details.x !== x || details.y !== y) {
        await foundry.moveToken({ tokenId, x, y });
      }
      if (details.hidden !== true) {
        await foundry.updateToken({ tokenId, hidden: true });
      }
      emit(true);
      return { tokenId };
    } catch (err) {
      emit(false);
      if (err instanceof TriggeredActionError) throw err;
      throw new TriggeredActionError(
        "token-update-failed",
        err instanceof Error ? err.message : String(err),
      );
    }
  },
});

function lootItem(item: {
  compendiumId?: string | undefined;
  itemId?: string | undefined;
  quantity: number;
}): {
  compendiumId?: string;
  itemId?: string;
  quantity: number;
} {
  return {
    quantity: item.quantity,
    ...(item.itemId !== undefined ? { itemId: item.itemId } : {}),
    ...(item.compendiumId !== undefined ? { compendiumId: item.compendiumId } : {}),
  };
}

function compactActorRef(ref: {
  compendiumId?: string | undefined;
  actorId?: string | undefined;
  namePack?: string | undefined;
}): { compendiumId?: string; actorId?: string; namePack?: string } {
  return {
    ...(ref.actorId !== undefined ? { actorId: ref.actorId } : {}),
    ...(ref.compendiumId !== undefined ? { compendiumId: ref.compendiumId } : {}),
    ...(ref.namePack !== undefined ? { namePack: ref.namePack } : {}),
  };
}

function actorRefKindOf(ref: {
  compendiumId?: string;
  actorId?: string;
  namePack?: string;
}): "compendium" | "actor" | "name-pack" {
  if (ref.actorId !== undefined) return "actor";
  if (ref.compendiumId !== undefined) return "compendium";
  return "name-pack";
}

async function resolveActorId(
  foundry: FoundryClient,
  ref: { compendiumId?: string; actorId?: string; namePack?: string },
): Promise<string> {
  if (ref.actorId !== undefined) {
    const existing = await foundry.getActor(ref.actorId);
    if (existing === null) {
      throw new TriggeredActionError("not-found", `actor ${ref.actorId} is not in the world`);
    }
    return existing.id;
  }
  if (ref.compendiumId !== undefined) {
    const { packId, itemId } = parseCompendiumRef(ref.compendiumId);
    const sourceId = `Compendium.${packId}.${itemId}`;
    const world = await foundry.listWorldActors();
    const already = world.find((a) => actorFlagSourceId(a) === sourceId);
    if (already !== undefined) return already.id;
    const created = await foundry.createActorFromCompendium({ packId, itemId });
    return created.id;
  }
  const name = ref.namePack ?? "";
  const hits = await foundry.searchCompendium(name);
  const hit = hits.find((h) => h.name.toLowerCase() === name.toLowerCase()) ?? hits[0];
  if (hit === undefined) {
    throw new TriggeredActionError("not-found", "no compendium actor matched namePack");
  }
  const packId = hit.packId ?? "";
  const sourceId = `Compendium.${packId}.${hit.id}`;
  const world = await foundry.listWorldActors();
  const already = world.find((a) => actorFlagSourceId(a) === sourceId);
  if (already !== undefined) return already.id;
  const created = await foundry.createActorFromCompendium({ packId, itemId: hit.id });
  return created.id;
}

export const shareJournalToAudienceDef = defineTool({
  name: "share_journal_to_audience",
  description:
    "Deliver a journal entry to table (public + voice excerpt), a single player (private note), or gm (no-op; already GM-visible). Long entries are excerpted.",
  mutatesWorld: false,
  inputSchema: z.object({
    journalId: z.string().min(1),
    audience: z.union([z.literal("table"), z.literal("gm"), z.string().regex(/^player:.+$/)]),
    excerpt: z
      .object({
        pageId: z.string().optional(),
        chars: z.number().int().positive().optional(),
      })
      .optional(),
  }),
  outputSchema: z.object({
    journalId: z.string(),
    audienceKind: z.enum(["table", "player", "gm"]),
    path: z.enum(["foundry-public-chat", "foundry-whisper", "gm-noop"]),
    excerpted: z.boolean(),
  }),
  async handle(input, ctx) {
    const campaignId = campaignIdOf(ctx);
    const audienceKind = audienceKindOf(input.audience);
    const path: "foundry-public-chat" | "foundry-whisper" | "gm-noop" =
      audienceKind === "table"
        ? "foundry-public-chat"
        : audienceKind === "player"
          ? "foundry-whisper"
          : "gm-noop";
    const emit = (success: boolean) =>
      trackAction(ctx, "action.share_journal_to_audience", {
        campaignId,
        audienceKind,
        path,
        success,
      });
    try {
      if (audienceKind === "gm") {
        emit(true);
        return { journalId: input.journalId, audienceKind, path, excerpted: false };
      }
      if (audienceKind === "player") {
        const playerId = input.audience.slice("player:".length);
        const consented =
          ctx.isPlayerConsented?.(playerId) ??
          ctx.tenantDb.consents.isGranted(playerId, "voice_processing");
        if (!consented) {
          throw new TriggeredActionError(
            "consent-rejected",
            "player has not granted consent for private delivery",
          );
        }
      }
      const foundry = requireFoundry(ctx);
      const journal = await foundry.getJournal(input.journalId);
      if (journal === null) {
        throw new TriggeredActionError("journal-not-found", "journal entry is not in the world");
      }
      const sourceText = journalPageText(journal, input.excerpt?.pageId);
      const cap = input.excerpt?.chars ?? JOURNAL_EXCERPT_DEFAULT;
      const excerpted = sourceText.length > cap;
      const excerpt = excerpted ? sourceText.slice(0, cap) : sourceText;
      const framedText =
        audienceKind === "player"
          ? `${PLAYER_NOTE_PREFIX} ${journal.name}\n\n${excerpt}\n\n(full entry: ${journal.name} — ask your DM to share)`
          : `${journal.name}\n\n${excerpt}`;
      const payload = {
        journalId: journal.id,
        title: journal.name,
        excerpt,
        framedText,
      };
      if (audienceKind === "table") {
        if (ctx.journalShare !== undefined) {
          await ctx.journalShare.shareTable(payload);
        } else {
          persistShare(ctx, TABLE_AUDIENCE, TABLE_CONVERSATION, framedText);
          await ctx.notifyTable?.(framedText);
        }
      } else {
        const playerId = input.audience.slice("player:".length);
        if (ctx.journalShare !== undefined) {
          await ctx.journalShare.sharePlayer({ ...payload, playerId });
        } else {
          persistShare(ctx, input.audience as Audience, input.audience, framedText);
          await ctx.whisperPlayer?.(playerId, framedText);
        }
      }
      emit(true);
      return { journalId: journal.id, audienceKind, path, excerpted };
    } catch (err) {
      emit(false);
      if (err instanceof TriggeredActionError) throw err;
      throw new TriggeredActionError(
        "share-failed",
        err instanceof Error ? err.message : String(err),
      );
    }
  },
});

function audienceKindOf(audience: string): "table" | "player" | "gm" {
  if (audience === "table") return "table";
  if (audience === "gm") return "gm";
  return "player";
}

function journalPageText(
  journal: { text: string; pages?: ReadonlyArray<{ id: string; text: string }> },
  pageId?: string,
): string {
  if (pageId !== undefined) {
    const page = journal.pages?.find((p) => p.id === pageId);
    if (page !== undefined) return page.text;
  }
  return journal.text;
}

function persistShare(
  ctx: ToolHandlerContext,
  audience: Audience,
  conversationId: string,
  text: string,
): void {
  ctx.tenantDb.dialogue.append({
    sessionId: ctx.sessionId,
    speaker: "narrator",
    text,
    timestamp: Date.now(),
    audience,
    conversationId,
  });
}

function actorFlagSourceId(actor: FoundryActor): string | undefined {
  const flags = actor.flags;
  if (flags === undefined) return undefined;
  const core = flags["core"];
  if (core !== null && typeof core === "object" && !Array.isArray(core)) {
    const sid = (core as Record<string, unknown>)["sourceId"];
    if (typeof sid === "string") return sid;
  }
  const direct = flags["compendiumSource"];
  return typeof direct === "string" ? direct : undefined;
}
