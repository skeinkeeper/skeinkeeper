// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { describe, expect, it } from "vitest";
import { McpFoundryClient, parseScene } from "./mcp_foundry_client.js";
import { FakeMcpToolCaller } from "./mcp_tool_caller.js";

describe("McpFoundryClient.connect", () => {
  it("derives the system from get-world-info", async () => {
    const caller = new FakeMcpToolCaller({
      "get-world-info": { system: "dnd5e", title: "Phandelver" },
    });
    const client = await McpFoundryClient.connect(caller);
    expect(client.system).toBe("dnd5e");
  });

  it("falls back to 'unknown' when no system field is present", async () => {
    const caller = new FakeMcpToolCaller({ "get-world-info": {} });
    const client = await McpFoundryClient.connect(caller);
    expect(client.system).toBe("unknown");
  });
});

describe("McpFoundryClient — reads", () => {
  it("lists party actors from list-characters", async () => {
    const caller = new FakeMcpToolCaller({
      "list-characters": {
        characters: [
          {
            id: "actor-1",
            name: "Aragorn",
            type: "character",
            system: { attributes: { hp: { value: 22, max: 30 } } },
          },
          {
            id: "actor-2",
            name: "Gimli",
            type: "character",
            system: { attributes: { hp: { value: 28, max: 28 } } },
          },
        ],
      },
    });
    const client = new McpFoundryClient(caller, "dnd5e");
    const party = await client.listPartyActors();
    expect(party).toHaveLength(2);
    expect(party[0]?.name).toBe("Aragorn");
    expect(party[0]?.id).toBe("actor-1");
    expect(party[0]?.system).toBe("dnd5e");
    expect((party[0]?.sheet as { attributes: { hp: { value: number } } }).attributes.hp.value).toBe(
      22,
    );
  });

  it("accepts a bare array response for list-characters", async () => {
    const caller = new FakeMcpToolCaller({
      "list-characters": [{ _id: "x", name: "Solo", type: "character" }],
    });
    const client = new McpFoundryClient(caller, "dnd5e");
    const party = await client.listPartyActors();
    expect(party).toHaveLength(1);
    expect(party[0]?.id).toBe("x"); // _id fallback
  });

  it("gets a single actor from get-character", async () => {
    const caller = new FakeMcpToolCaller({
      "get-character": {
        character: {
          id: "a1",
          name: "Sildar",
          type: "npc",
          system: { foo: 1 },
          flags: { note: "ally" },
        },
      },
    });
    const client = new McpFoundryClient(caller, "dnd5e");
    const actor = await client.getActor("a1");
    expect(actor?.name).toBe("Sildar");
    expect(actor?.type).toBe("npc");
    expect(actor?.flags?.["note"]).toBe("ally");
  });

  it("returns null when get-character yields no actor record", async () => {
    const caller = new FakeMcpToolCaller({ "get-character": null });
    const client = new McpFoundryClient(caller, "dnd5e");
    expect(await client.getActor("missing")).toBeNull();
  });

  it("parses the active scene with tokens", async () => {
    const caller = new FakeMcpToolCaller({
      "get-current-scene": {
        scene: {
          id: "scene-1",
          name: "Stonehill Inn",
          description: "smells of stew",
          active: true,
          tokens: [
            { actorId: "a1", name: "Aragorn", disposition: 1 },
            { actorId: "npc1", name: "Glasstaff", disposition: -1 },
          ],
        },
      },
    });
    const client = new McpFoundryClient(caller, "dnd5e");
    const scene = await client.getActiveScene();
    expect(scene?.name).toBe("Stonehill Inn");
    expect(scene?.description).toBe("smells of stew");
    expect(scene?.tokens).toHaveLength(2);
    expect(scene?.tokens[1]?.disposition).toBe(-1);
  });
});

describe("McpFoundryClient — writes (bridge mutation gap)", () => {
  it("maps a condition update to toggle-token-condition", async () => {
    const caller = new FakeMcpToolCaller({ "toggle-token-condition": { ok: true } });
    const client = new McpFoundryClient(caller, "dnd5e");
    await client.applyActorUpdate("a1", { condition: "frightened", active: true });
    expect(caller.calls[0]?.name).toBe("toggle-token-condition");
    expect(caller.calls[0]?.args).toMatchObject({
      actorId: "a1",
      condition: "frightened",
      active: true,
    });
  });

  it("rejects a direct HP update with an actionable error", async () => {
    const caller = new FakeMcpToolCaller({});
    const client = new McpFoundryClient(caller, "dnd5e");
    await expect(
      client.applyActorUpdate("a1", { "system.attributes.hp.value": 5 }),
    ).rejects.toThrow(/no generic actor-update tool/);
  });

  it("rejects server-side rollDice (bridge has only interactive rolls)", async () => {
    const caller = new FakeMcpToolCaller({});
    const client = new McpFoundryClient(caller, "dnd5e");
    await expect(client.rollDice()).rejects.toThrow(/no server-side roll tool/);
  });
});

describe("parseScene", () => {
  it("returns null for a response missing id or name", () => {
    expect(parseScene({ scene: { id: "x" } })).toBeNull();
    expect(parseScene(null)).toBeNull();
  });

  it("defaults active to true and tokens to empty", () => {
    const scene = parseScene({ id: "s", name: "Void" });
    expect(scene?.active).toBe(true);
    expect(scene?.tokens).toEqual([]);
  });
});

describe("McpFoundryClient — scenes (ADR-0015)", () => {
  it("lists scenes from list-scenes", async () => {
    const caller = new FakeMcpToolCaller({
      "get-world-info": { system: "dnd5e" },
      "list-scenes": {
        scenes: [
          { id: "s1", name: "Stonehill Inn", active: true },
          { id: "s2", name: "Cragmaw Hideout", active: false },
        ],
      },
    });
    const client = await McpFoundryClient.connect(caller);
    const scenes = await client.listScenes();
    expect(scenes).toEqual([
      { id: "s1", name: "Stonehill Inn", active: true },
      { id: "s2", name: "Cragmaw Hideout", active: false },
    ]);
  });

  it("createActorFromCompendium calls create-actor-from-compendium", async () => {
    const caller = new FakeMcpToolCaller({
      "get-world-info": { system: "dnd5e" },
      "create-actor-from-compendium": {
        actor: { id: "imp-1", name: "Goblin", type: "npc" },
      },
    });
    const client = await McpFoundryClient.connect(caller);
    const actor = await client.createActorFromCompendium({
      packId: "dnd5e.monsters",
      itemId: "goblin",
    });
    expect(actor.name).toBe("Goblin");
    expect(caller.calls.find((c) => c.name === "create-actor-from-compendium")?.args).toEqual({
      packId: "dnd5e.monsters",
      itemId: "goblin",
    });
  });

  it("setActiveScene calls switch-scene with scene_identifier", async () => {
    const caller = new FakeMcpToolCaller({
      "get-world-info": { system: "dnd5e" },
      "switch-scene": { success: true },
    });
    const client = await McpFoundryClient.connect(caller);
    await client.setActiveScene("Cragmaw Hideout");
    const call = caller.calls.find((c) => c.name === "switch-scene");
    expect(call?.args).toEqual({ scene_identifier: "Cragmaw Hideout" });
  });
});

describe("McpFoundryClient — intake reads (TDD 0031)", () => {
  it("maps get-world-info to system + modules", async () => {
    const caller = new FakeMcpToolCaller({
      "get-world-info": {
        system: "dnd5e",
        systemTitle: "D&D 5e",
        modules: [
          { id: "lmop", title: "Lost Mine of Phandelver", active: true },
          { id: "dice-so-nice", title: "Dice So Nice", active: true },
        ],
      },
    });
    const client = new McpFoundryClient(caller, "dnd5e");
    const info = await client.getWorldInfo();
    expect(info.connected).toBe(true);
    expect(info.system).toEqual({ id: "dnd5e", name: "D&D 5e" });
    expect(info.modules).toHaveLength(2);
    expect(info.modules[0]?.id).toBe("lmop");
  });

  it("returns no users (MCP has no list-users tool)", async () => {
    const client = new McpFoundryClient(new FakeMcpToolCaller({}), "dnd5e");
    expect(await client.listUsers()).toEqual([]);
  });

  it("lists packs, creatures, and search hits", async () => {
    const caller = new FakeMcpToolCaller({
      "list-compendium-packs": {
        packs: [{ id: "dnd5e.monsters", label: "Monsters", type: "Actor" }],
      },
      "list-creatures-by-criteria": {
        creatures: [{ id: "gob-1", name: "Goblin", packId: "dnd5e.monsters" }],
      },
      "search-compendium": {
        results: [{ id: "r-1", name: "Human", pack: { id: "dnd5e.races" }, type: "race" }],
      },
      "search-journals": { results: [{ id: "j-1", name: "Gundren" }] },
    });
    const client = new McpFoundryClient(caller, "dnd5e");
    expect((await client.listCompendiumPacks())[0]?.id).toBe("dnd5e.monsters");
    expect((await client.listCreaturesByCriteria({ name: "Goblin" }))[0]?.name).toBe("Goblin");
    expect((await client.searchCompendium("Human"))[0]?.packId).toBe("dnd5e.races");
    expect((await client.searchJournals("Gundren"))[0]?.name).toBe("Gundren");
  });
});

describe("McpFoundryClient — add-actor-items (TDD 0033)", () => {
  it("addActorItems wraps add-actor-items per item payload", async () => {
    const caller = new FakeMcpToolCaller({ "add-actor-items": { ok: true } });
    const client = new McpFoundryClient(caller, "dnd5e");
    await client.addActorItems({
      actorId: "hero-1",
      items: [{ itemId: "potion", quantity: 2 }],
    });
    expect(caller.calls[0]).toEqual({
      name: "add-actor-items",
      args: { actorId: "hero-1", items: [{ itemId: "potion", quantity: 2 }] },
    });
  });
});

describe("McpFoundryClient — token visibility (TDD 0033)", () => {
  it("updateToken wraps update-token", async () => {
    const caller = new FakeMcpToolCaller({ "update-token": { ok: true } });
    const client = new McpFoundryClient(caller, "dnd5e");
    await client.updateToken({ tokenId: "tok-1", hidden: false });
    expect(caller.calls[0]).toEqual({
      name: "update-token",
      args: { tokenId: "tok-1", hidden: false },
    });
  });

  it("getTokenDetails wraps get-token-details", async () => {
    const caller = new FakeMcpToolCaller({
      "get-token-details": { token: { id: "tok-1", actorId: "a1", name: "Goblin", hidden: true } },
    });
    const client = new McpFoundryClient(caller, "dnd5e");
    const tok = await client.getTokenDetails("tok-1");
    expect(tok).toEqual({ id: "tok-1", actorId: "a1", name: "Goblin", hidden: true });
  });
});
