// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { describe, expect, it } from "vitest";
import { MockFoundryClient } from "./mock.js";
import type { FoundryActor, FoundryScene } from "./client.js";

const aragorn: FoundryActor = {
  id: "ch-aragorn",
  name: "Aragorn",
  type: "character",
  system: "dnd5e",
  sheet: { attributes: { hp: { value: 22, max: 30 } } },
};
const sildar: FoundryActor = {
  id: "npc-sildar",
  name: "Sildar",
  type: "npc",
  system: "dnd5e",
  sheet: { attributes: { hp: { value: 12, max: 12 } } },
};
const tavern: FoundryScene = {
  id: "scene-tavern",
  name: "Stonehill Inn",
  active: true,
  tokens: [
    { actorId: aragorn.id, name: aragorn.name },
    { actorId: sildar.id, name: sildar.name },
  ],
};

describe("MockFoundryClient", () => {
  it("returns party actors by configured IDs", async () => {
    const f = new MockFoundryClient({
      system: "dnd5e",
      actors: [aragorn, sildar],
      partyActorIds: ["ch-aragorn"],
    });
    const party = await f.listPartyActors();
    expect(party).toHaveLength(1);
    expect(party[0]?.id).toBe("ch-aragorn");
  });

  it("returns scene actors via token lookups", async () => {
    const f = new MockFoundryClient({
      system: "dnd5e",
      actors: [aragorn, sildar],
      scenes: [tavern],
      activeSceneId: "scene-tavern",
    });
    const scene = await f.getActiveScene();
    expect(scene?.name).toBe("Stonehill Inn");
    const onScene = await f.listSceneActors("scene-tavern");
    expect(onScene.map((a) => a.id).sort()).toEqual(["ch-aragorn", "npc-sildar"]);
  });

  it("records actor updates", async () => {
    const f = new MockFoundryClient({ system: "dnd5e", actors: [aragorn] });
    await f.applyActorUpdate("ch-aragorn", { system: { attributes: { hp: { value: 18 } } } });
    expect(f.updates).toHaveLength(1);
    expect(f.updates[0]?.actorId).toBe("ch-aragorn");
  });

  it("records dice rolls and returns the configured result", async () => {
    const f = new MockFoundryClient({ system: "dnd5e" });
    f.rollResultFor = (formula) => ({ total: 17, rolls: [14], formula });
    const result = await f.rollDice("1d20+3", { speaker: "Aragorn" });
    expect(result.total).toBe(17);
    expect(f.rolls).toHaveLength(1);
    expect(f.rolls[0]?.speaker).toBe("Aragorn");
  });

  it("returns null for missing actors and inactive scenes", async () => {
    const f = new MockFoundryClient({ system: "dnd5e" });
    expect(await f.getActor("missing")).toBeNull();
    expect(await f.getActiveScene()).toBeNull();
    expect(await f.listSceneActors("missing")).toEqual([]);
  });

  it("records deleteChatMessages and returns the configured count (TDD 0038)", async () => {
    const f = new MockFoundryClient({ system: "dnd5e" });
    f.deleteChatMessagesResultFor = (args) => ({
      deletedCount: args.scope === "by-recipient" ? 7 : 3,
    });
    expect(
      await f.deleteChatMessages({ scope: "by-recipient", recipientFoundryUserId: "u1" }),
    ).toEqual({ deletedCount: 7 });
    expect(await f.deleteChatMessages({ scope: "by-author", authorFoundryUserId: "u1" })).toEqual({
      deletedCount: 3,
    });
    expect(f.chatDeletes).toEqual([
      { scope: "by-recipient", recipientFoundryUserId: "u1" },
      { scope: "by-author", authorFoundryUserId: "u1" },
    ]);
  });
});

describe("MockFoundryClient — scenes (ADR-0015)", () => {
  const cragmaw: FoundryScene = {
    id: "scene-cragmaw",
    name: "Cragmaw Hideout",
    active: false,
    tokens: [],
  };

  it("lists scenes with the active flag and switches by id or name", async () => {
    const f = new MockFoundryClient({
      system: "dnd5e",
      scenes: [tavern, cragmaw],
      activeSceneId: "scene-tavern",
    });
    let scenes = await f.listScenes();
    expect(scenes.map((s) => `${s.name}:${s.active}`).sort()).toEqual([
      "Cragmaw Hideout:false",
      "Stonehill Inn:true",
    ]);

    // switch by case-insensitive name
    await f.setActiveScene("cragmaw hideout");
    expect((await f.getActiveScene())?.id).toBe("scene-cragmaw");

    // switch by id
    await f.setActiveScene("scene-tavern");
    expect((await f.getActiveScene())?.id).toBe("scene-tavern");
    scenes = await f.listScenes();
    expect(scenes.find((s) => s.id === "scene-tavern")?.active).toBe(true);
  });

  it("ignores a switch to an unknown scene", async () => {
    const f = new MockFoundryClient({
      system: "dnd5e",
      scenes: [tavern],
      activeSceneId: "scene-tavern",
    });
    await f.setActiveScene("nonexistent");
    expect((await f.getActiveScene())?.id).toBe("scene-tavern");
  });
});

describe("MockFoundryClient — table-text (TDD 0034)", () => {
  it("records postChatMessage and returns a message id", async () => {
    const f = new MockFoundryClient({ system: "dnd5e" });
    const r = await f.postChatMessage({
      content: "The door creaks.",
      mode: "public",
    });
    expect(r.messageId).toBe("msg-1");
    expect(f.chatPosts).toEqual([{ content: "The door creaks.", mode: "public" }]);
  });

  it("delivers subscribeChatEvents to every handler and unsubscribes", () => {
    const f = new MockFoundryClient({ system: "dnd5e" });
    const a: string[] = [];
    const b: string[] = [];
    const unsubA = f.subscribeChatEvents((e) => a.push(e.text));
    const unsubB = f.subscribeChatEvents((e) => b.push(e.text));
    f.emitChatEvent({
      foundryUserId: "u1",
      text: "hello",
      isWhisper: false,
      timestamp: "t0",
    });
    unsubA();
    f.emitChatEvent({
      foundryUserId: "u1",
      text: "again",
      isWhisper: false,
      timestamp: "t1",
    });
    unsubB();
    expect(a).toEqual(["hello"]);
    expect(b).toEqual(["hello", "again"]);
  });
});

describe("MockFoundryClient — token visibility (TDD 0033)", () => {
  it("updateToken toggles hidden and getTokenDetails reflects it", async () => {
    const f = new MockFoundryClient({
      system: "dnd5e",
      actors: [sildar],
      scenes: [
        {
          id: "scene-tavern",
          name: "Stonehill Inn",
          active: true,
          tokens: [{ id: "tok-sildar", actorId: sildar.id, name: sildar.name, hidden: true }],
        },
      ],
      activeSceneId: "scene-tavern",
    });
    expect((await f.getTokenDetails("tok-sildar"))?.hidden).toBe(true);
    await f.updateToken({ tokenId: "tok-sildar", hidden: false });
    expect((await f.getTokenDetails("tok-sildar"))?.hidden).toBe(false);
    await f.updateToken({ tokenId: "tok-sildar", hidden: true });
    expect((await f.getTokenDetails("tok-sildar"))?.hidden).toBe(true);
  });
});
