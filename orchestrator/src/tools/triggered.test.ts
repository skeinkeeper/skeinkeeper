// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { describe, expect, it, vi } from "vitest";
import { openDb, TenantDb, schema } from "@skeinkeeper/server";
import { MockFoundryClient } from "../foundry/mock.js";
import { ToolDispatcher } from "../registry.js";
import {
  distributeLootDef,
  hideTokenDef,
  placeHiddenTokenDef,
  revealTokenDef,
  shareJournalToAudienceDef,
} from "./triggered.js";
import { ToolRegistry } from "../registry.js";

function setup() {
  const db = openDb({ path: ":memory:", runMigrations: true });
  db.insert(schema.tenants).values({ id: "default", name: "Test", createdAt: Date.now() }).run();
  db.insert(schema.campaigns)
    .values({
      id: "c1",
      tenantId: "default",
      name: "Test",
      rulesetId: "dnd5e",
      behaviorSpecVersion: "v0.1",
      status: "active",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    .run();
  const tenantDb = new TenantDb(db, "default");
  tenantDb.sessions.create({
    id: "s",
    campaignId: "c1",
    behaviorSpecVersion: "v0.1",
    startedAt: Date.now(),
  });
  const registry = new ToolRegistry();
  registry.register(revealTokenDef);
  registry.register(hideTokenDef);
  registry.register(distributeLootDef);
  registry.register(placeHiddenTokenDef);
  registry.register(shareJournalToAudienceDef);
  const analytics = { track: vi.fn(), flush: vi.fn().mockResolvedValue(undefined) };
  return {
    tenantDb,
    analytics,
    dispatcher: new ToolDispatcher({ registry, analytics }),
  };
}

function hiddenGoblin() {
  return new MockFoundryClient({
    system: "dnd5e",
    actors: [{ id: "gob-1", name: "Goblin", type: "npc", system: "dnd5e", sheet: {} }],
    scenes: [
      {
        id: "scene-cave",
        name: "Cave",
        active: true,
        tokens: [{ id: "tok-gob", actorId: "gob-1", name: "Goblin", hidden: true, x: 100, y: 80 }],
      },
    ],
    activeSceneId: "scene-cave",
  });
}

describe("reveal_token / hide_token", () => {
  it("reveal_token sets hidden:false and hide_token reverses (get-token-details matches)", async () => {
    const { tenantDb, dispatcher } = setup();
    const foundry = hiddenGoblin();
    const ctx = {
      tenantDb,
      sessionId: "s",
      turnId: "t",
      caller: "llm" as const,
      foundry,
      campaignId: "c1",
    };

    const revealed = await dispatcher.dispatch(
      { name: "reveal_token", input: { tokenId: "tok-gob" } },
      ctx,
    );
    expect(revealed.ok).toBe(true);
    const afterReveal = await foundry.getTokenDetails("tok-gob");
    expect(afterReveal?.hidden).toBe(false);

    const hidden = await dispatcher.dispatch(
      { name: "hide_token", input: { tokenId: "tok-gob" } },
      ctx,
    );
    expect(hidden.ok).toBe(true);
    const afterHide = await foundry.getTokenDetails("tok-gob");
    expect(afterHide?.hidden).toBe(true);
    expect(foundry.tokenUpdates.map((u) => u.hidden)).toEqual([false, true]);
  });

  it("returns failure when update-token cannot find the token", async () => {
    const { tenantDb, dispatcher } = setup();
    const foundry = hiddenGoblin();
    const result = await dispatcher.dispatch(
      { name: "reveal_token", input: { tokenId: "tok-missing" } },
      {
        tenantDb,
        sessionId: "s",
        turnId: "t",
        caller: "llm",
        foundry,
        campaignId: "c1",
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/token-update-failed|not found/i);
  });

  it("emits action.reveal_token / action.hide_token without token ids", async () => {
    const { tenantDb, dispatcher, analytics } = setup();
    const foundry = hiddenGoblin();
    const ctx = {
      tenantDb,
      sessionId: "s",
      turnId: "t",
      caller: "llm" as const,
      foundry,
      campaignId: "c1",
      analytics,
    };
    await dispatcher.dispatch({ name: "reveal_token", input: { tokenId: "tok-gob" } }, ctx);
    await dispatcher.dispatch({ name: "hide_token", input: { tokenId: "tok-gob" } }, ctx);
    expect(analytics.track).toHaveBeenCalledWith(
      "action.reveal_token",
      expect.objectContaining({ campaignId: "c1", success: true }),
    );
    expect(analytics.track).toHaveBeenCalledWith(
      "action.hide_token",
      expect.objectContaining({ campaignId: "c1", success: true }),
    );
    const payloads = analytics.track.mock.calls
      .filter((c) => c[0] === "action.reveal_token" || c[0] === "action.hide_token")
      .map((c) => JSON.stringify(c[1]));
    expect(payloads.some((p) => p.includes("tok-gob"))).toBe(false);
  });
});

function partyFoundry() {
  return new MockFoundryClient({
    system: "dnd5e",
    actors: [
      { id: "hero-1", name: "Hero", type: "character", system: "dnd5e", sheet: {} },
      { id: "hero-2", name: "Scout", type: "character", system: "dnd5e", sheet: {} },
      { id: "npc-gob", name: "Goblin", type: "npc", system: "dnd5e", sheet: {} },
    ],
    partyActorIds: ["hero-1", "hero-2"],
  });
}

describe("distribute_loot", () => {
  it("adds items to party actors and returns per-item status", async () => {
    const { tenantDb, dispatcher, analytics } = setup();
    const foundry = partyFoundry();
    const result = await dispatcher.dispatch(
      {
        name: "distribute_loot",
        input: {
          distributions: [
            {
              actorId: "hero-1",
              items: [
                { itemId: "potion", quantity: 2 },
                { compendiumId: "dnd5e.items.gold", quantity: 10 },
              ],
            },
            { actorId: "hero-2", items: [{ itemId: "rations", quantity: 1 }] },
          ],
        },
      },
      {
        tenantDb,
        sessionId: "s",
        turnId: "t",
        caller: "llm",
        foundry,
        campaignId: "c1",
        analytics,
      },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      const out = result.output as { partialFailure: boolean; items: Array<{ ok: boolean }> };
      expect(out.partialFailure).toBe(false);
      expect(out.items).toHaveLength(3);
      expect(out.items.every((i) => i.ok)).toBe(true);
    }
    expect(foundry.addedItems).toHaveLength(3);
    expect(analytics.track).toHaveBeenCalledWith(
      "action.distribute_loot",
      expect.objectContaining({
        campaignId: "c1",
        recipientCount: 2,
        itemCount: 3,
        partialFailure: false,
      }),
    );
  });

  it("rejects a non-party recipient without calling the bridge", async () => {
    const { tenantDb, dispatcher, analytics } = setup();
    const foundry = partyFoundry();
    const result = await dispatcher.dispatch(
      {
        name: "distribute_loot",
        input: {
          distributions: [
            { actorId: "hero-1", items: [{ itemId: "potion", quantity: 1 }] },
            { actorId: "npc-gob", items: [{ itemId: "sword", quantity: 1 }] },
          ],
        },
      },
      {
        tenantDb,
        sessionId: "s",
        turnId: "t",
        caller: "llm",
        foundry,
        campaignId: "c1",
        analytics,
      },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      const out = result.output as {
        partialFailure: boolean;
        items: Array<{ actorId: string; ok: boolean; error?: string }>;
      };
      expect(out.partialFailure).toBe(true);
      expect(out.items.find((i) => i.actorId === "npc-gob")?.ok).toBe(false);
      expect(out.items.find((i) => i.actorId === "npc-gob")?.error).toMatch(/not-party-actor/);
    }
    expect(foundry.addedItems).toEqual([]);
    expect(analytics.track).toHaveBeenCalledWith(
      "action.distribute_loot",
      expect.objectContaining({ partialFailure: true, itemCount: 2 }),
    );
  });

  it("continues after one item failure and does not roll back", async () => {
    const { tenantDb, dispatcher } = setup();
    const foundry = partyFoundry();
    foundry.addActorItems = async (args) => {
      if (args.items[0]?.itemId === "cursed") throw new Error("bridge refused");
      return MockFoundryClient.prototype.addActorItems.call(foundry, args);
    };
    const result = await dispatcher.dispatch(
      {
        name: "distribute_loot",
        input: {
          distributions: [
            {
              actorId: "hero-1",
              items: [
                { itemId: "potion", quantity: 1 },
                { itemId: "cursed", quantity: 1 },
                { itemId: "rations", quantity: 1 },
              ],
            },
          ],
        },
      },
      { tenantDb, sessionId: "s", turnId: "t", caller: "llm", foundry, campaignId: "c1" },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      const out = result.output as { partialFailure: boolean; items: Array<{ ok: boolean }> };
      expect(out.partialFailure).toBe(true);
      expect(out.items.map((i) => i.ok)).toEqual([true, false, true]);
    }
    expect(foundry.addedItems.map((a) => a.items[0]?.itemId)).toEqual(["potion", "rations"]);
  });
});

describe("place_hidden_token", () => {
  it("places via createToken hidden:true when the actor is already in-world", async () => {
    const { tenantDb, dispatcher } = setup();
    const foundry = new MockFoundryClient({
      system: "dnd5e",
      actors: [{ id: "gob-1", name: "Goblin", type: "npc", system: "dnd5e", sheet: {} }],
      scenes: [{ id: "scene-cave", name: "Cave", active: true, tokens: [] }],
      activeSceneId: "scene-cave",
    });
    const result = await dispatcher.dispatch(
      {
        name: "place_hidden_token",
        input: {
          actorRef: { actorId: "gob-1" },
          sceneId: "scene-cave",
          coords: { x: 400, y: 300 },
          disposition: "hostile",
        },
      },
      { tenantDb, sessionId: "s", turnId: "t", caller: "llm", foundry, campaignId: "c1" },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected place_hidden_token to succeed");
    expect((result.output as { tokenId: string }).tokenId.length).toBeGreaterThan(0);
    const created = foundry.createdTokens[0];
    expect(created?.hidden).toBe(true);
    expect(created?.x).toBe(400);
    expect(created?.y).toBe(300);
    const tok = await foundry.getTokenDetails((result.output as { tokenId: string }).tokenId);
    expect(tok?.hidden).toBe(true);
  });

  it("two-step fallback: move-token + update-token hidden when spawn ignores coords", async () => {
    const { tenantDb, dispatcher } = setup();
    const foundry = new MockFoundryClient({
      system: "dnd5e",
      scenes: [{ id: "scene-cave", name: "Cave", active: true, tokens: [] }],
      activeSceneId: "scene-cave",
      compendiumHits: [{ id: "goblin", name: "Goblin", packId: "dnd5e.monsters", type: "npc" }],
    });
    foundry.createTokenIgnoresCoords = true;
    const result = await dispatcher.dispatch(
      {
        name: "place_hidden_token",
        input: {
          actorRef: { compendiumId: "dnd5e.monsters.goblin" },
          sceneId: "scene-cave",
          coords: { x: 400, y: 300 },
        },
      },
      { tenantDb, sessionId: "s", turnId: "t", caller: "llm", foundry, campaignId: "c1" },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected place_hidden_token to succeed");
    const tokenId = (result.output as { tokenId: string }).tokenId;
    expect(
      foundry.movedTokens.some((m) => m.tokenId === tokenId && m.x === 400 && m.y === 300),
    ).toBe(true);
    expect((await foundry.getTokenDetails(tokenId))?.hidden).toBe(true);
  });

  it("raises bridge-coverage-gap and notifies the operator when no token spawns", async () => {
    const { tenantDb, dispatcher } = setup();
    const foundry = new MockFoundryClient({
      system: "dnd5e",
      scenes: [{ id: "scene-cave", name: "Cave", active: true, tokens: [] }],
      activeSceneId: "scene-cave",
      compendiumHits: [{ id: "ghost", name: "Ghost", packId: "dnd5e.monsters", type: "npc" }],
    });
    foundry.spawnTokenOnCreate = false;
    const notices: string[] = [];
    const result = await dispatcher.dispatch(
      {
        name: "place_hidden_token",
        input: {
          actorRef: { compendiumId: "dnd5e.monsters.ghost" },
          sceneId: "scene-cave",
          coords: { x: 10, y: 10 },
        },
      },
      {
        tenantDb,
        sessionId: "s",
        turnId: "t",
        caller: "llm",
        foundry,
        campaignId: "c1",
        notifyOperator: async (m) => {
          notices.push(m);
        },
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/bridge-coverage-gap/);
    expect(notices.length).toBe(1);
    expect(notices[0]).toMatch(/bridge-coverage-gap/);
  });

  it("raises scene-changed-mid-action when the active scene is not the requested one", async () => {
    const { tenantDb, dispatcher } = setup();
    const foundry = new MockFoundryClient({
      system: "dnd5e",
      actors: [{ id: "gob-1", name: "Goblin", type: "npc", system: "dnd5e", sheet: {} }],
      scenes: [
        { id: "scene-cave", name: "Cave", active: false, tokens: [] },
        { id: "scene-inn", name: "Inn", active: true, tokens: [] },
      ],
      activeSceneId: "scene-inn",
    });
    const result = await dispatcher.dispatch(
      {
        name: "place_hidden_token",
        input: { actorRef: { actorId: "gob-1" }, sceneId: "scene-cave" },
      },
      { tenantDb, sessionId: "s", turnId: "t", caller: "llm", foundry, campaignId: "c1" },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/scene-changed-mid-action/);
    expect(foundry.createdTokens).toEqual([]);
  });
});

describe("share_journal_to_audience", () => {
  function journalFoundry() {
    const foundry = new MockFoundryClient({
      system: "dnd5e",
      journals: [
        {
          id: "j-note",
          name: "Sildar's Letter",
          text: "Meet me at the inn. ".repeat(200),
          pages: [{ id: "p1", name: "Body", text: "Short page body." }],
        },
      ],
    });
    return foundry;
  }

  it("table audience writes table dialogue and does not whisper players", async () => {
    const { tenantDb, dispatcher, analytics } = setup();
    const foundry = journalFoundry();
    const table: string[] = [];
    const whispers: Array<{ playerId: string; text: string }> = [];
    const result = await dispatcher.dispatch(
      { name: "share_journal_to_audience", input: { journalId: "j-note", audience: "table" } },
      {
        tenantDb,
        sessionId: "s",
        turnId: "t",
        caller: "llm",
        foundry,
        campaignId: "c1",
        analytics,
        notifyTable: async (text) => {
          table.push(text);
        },
        whisperPlayer: async (playerId, text) => {
          whispers.push({ playerId, text });
        },
      },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      const out = result.output as { path: string; audienceKind: string };
      expect(out.path).toBe("foundry-public-chat");
      expect(out.audienceKind).toBe("table");
    }
    expect(table.length).toBe(1);
    expect(table[0]).toContain("Sildar's Letter");
    expect(whispers).toEqual([]);
    const rows = tenantDb.dialogue.listBySession("s");
    expect(rows.every((r) => r.audience === "table")).toBe(true);
    expect(analytics.track).toHaveBeenCalledWith(
      "action.share_journal_to_audience",
      expect.objectContaining({
        audienceKind: "table",
        path: "foundry-public-chat",
        success: true,
      }),
    );
  });

  it("player audience frames a whisper and leaves other players untouched", async () => {
    const { tenantDb, dispatcher } = setup();
    const foundry = journalFoundry();
    const whispers: Array<{ playerId: string; text: string }> = [];
    const result = await dispatcher.dispatch(
      {
        name: "share_journal_to_audience",
        input: { journalId: "j-note", audience: "player:p1", excerpt: { chars: 40 } },
      },
      {
        tenantDb,
        sessionId: "s",
        turnId: "t",
        caller: "llm",
        foundry,
        campaignId: "c1",
        isPlayerConsented: (id) => id === "p1",
        whisperPlayer: async (playerId, text) => {
          whispers.push({ playerId, text });
        },
      },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect((result.output as { path: string }).path).toBe("foundry-whisper");
    expect(whispers).toHaveLength(1);
    expect(whispers[0]?.playerId).toBe("p1");
    expect(whispers[0]?.text).toContain("*A note slips into your hand:*");
    expect(whispers[0]?.text).toContain("Sildar's Letter");
    expect(whispers[0]?.text).toContain("ask your DM to share");
    expect(whispers[0]?.text.length).toBeLessThan(400);
    const rows = tenantDb.dialogue.listBySession("s");
    expect(rows.map((r) => r.audience)).toEqual(["player:p1"]);
  });

  it("rejects a non-consented player audience", async () => {
    const { tenantDb, dispatcher } = setup();
    const foundry = journalFoundry();
    const whispers: string[] = [];
    const result = await dispatcher.dispatch(
      {
        name: "share_journal_to_audience",
        input: { journalId: "j-note", audience: "player:p2" },
      },
      {
        tenantDb,
        sessionId: "s",
        turnId: "t",
        caller: "llm",
        foundry,
        campaignId: "c1",
        isPlayerConsented: () => false,
        whisperPlayer: async (text) => {
          whispers.push(text);
        },
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/consent-rejected/);
    expect(whispers).toEqual([]);
    expect(tenantDb.dialogue.listBySession("s")).toEqual([]);
  });

  it("gm audience is a no-op success", async () => {
    const { tenantDb, dispatcher, analytics } = setup();
    const foundry = journalFoundry();
    const result = await dispatcher.dispatch(
      { name: "share_journal_to_audience", input: { journalId: "j-note", audience: "gm" } },
      {
        tenantDb,
        sessionId: "s",
        turnId: "t",
        caller: "llm",
        foundry,
        campaignId: "c1",
        analytics,
      },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect((result.output as { path: string }).path).toBe("gm-noop");
    expect(tenantDb.dialogue.listBySession("s")).toEqual([]);
    expect(analytics.track).toHaveBeenCalledWith(
      "action.share_journal_to_audience",
      expect.objectContaining({ audienceKind: "gm", path: "gm-noop", success: true }),
    );
  });
});
