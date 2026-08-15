// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { describe, expect, it, vi } from "vitest";
import { openDb, TenantDb, schema } from "@skeinkeeper/server";
import { MockFoundryClient } from "../foundry/mock.js";
import { ToolDispatcher } from "../registry.js";
import { hideTokenDef, revealTokenDef } from "./triggered.js";
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
