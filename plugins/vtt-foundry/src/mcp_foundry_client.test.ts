// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { describe, expect, it } from "vitest";
import { McpFoundryClient, parseScene } from "./mcp_foundry_client.js";
import { FakeMcpToolCaller } from "./mcp_tool_caller.js";

describe("McpFoundryClient.connect", () => {
  it("derives the system from get-world-info", async () => {
    const caller = new FakeMcpToolCaller({ "get-world-info": { system: "dnd5e", title: "Phandelver" } });
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
          { id: "actor-1", name: "Aragorn", type: "character", system: { attributes: { hp: { value: 22, max: 30 } } } },
          { id: "actor-2", name: "Gimli", type: "character", system: { attributes: { hp: { value: 28, max: 28 } } } },
        ],
      },
    });
    const client = new McpFoundryClient(caller, "dnd5e");
    const party = await client.listPartyActors();
    expect(party).toHaveLength(2);
    expect(party[0]?.name).toBe("Aragorn");
    expect(party[0]?.id).toBe("actor-1");
    expect(party[0]?.system).toBe("dnd5e");
    expect((party[0]?.sheet as { attributes: { hp: { value: number } } }).attributes.hp.value).toBe(22);
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
      "get-character": { character: { id: "a1", name: "Sildar", type: "npc", system: { foo: 1 }, flags: { note: "ally" } } },
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
    expect(caller.calls[0]?.args).toMatchObject({ actorId: "a1", condition: "frightened", active: true });
  });

  it("rejects a direct HP update with an actionable error", async () => {
    const caller = new FakeMcpToolCaller({});
    const client = new McpFoundryClient(caller, "dnd5e");
    await expect(client.applyActorUpdate("a1", { "system.attributes.hp.value": 5 })).rejects.toThrow(
      /no generic actor-update tool/,
    );
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
