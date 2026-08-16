// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { describe, expect, it } from "vitest";
import { openDb, TenantDb, schema } from "@skeinkeeper/server";
import {
  MockFoundryClient,
  ToolDispatcher,
  ToolRegistry,
  type FoundryClient,
  type ToolHandlerContext,
} from "@skeinkeeper/orchestrator";
import { DND5E_WRITE_TOOLS, registerFoundrySystemTools } from "./tools.js";

function bootstrap() {
  const db = openDb({ path: ":memory:", runMigrations: true });
  db.insert(schema.tenants).values({ id: "default", name: "Test", createdAt: Date.now() }).run();
  const tenantDb = new TenantDb(db, "default");
  const registry = new ToolRegistry();
  registerFoundrySystemTools(registry, "dnd5e");
  return { tenantDb, dispatcher: new ToolDispatcher({ registry }) };
}

function ctx(tenantDb: TenantDb, foundry?: FoundryClient): ToolHandlerContext {
  return {
    tenantDb,
    sessionId: "s",
    turnId: "t",
    caller: "llm",
    ...(foundry !== undefined ? { foundry } : {}),
  };
}

/** dnd5e world: one PC token and one goblin token on the active scene. */
function dnd5eWorld() {
  return new MockFoundryClient({
    system: "dnd5e",
    actors: [
      {
        id: "pc-1",
        name: "Fighter",
        type: "character",
        system: "dnd5e",
        sheet: { attributes: { hp: { value: 12, max: 12 } } },
      },
      {
        id: "gob-1",
        name: "Goblin",
        type: "npc",
        system: "dnd5e",
        sheet: { attributes: { hp: { value: 7, max: 7 } } },
      },
    ],
    scenes: [
      {
        id: "scene-1",
        name: "Cave",
        active: true,
        tokens: [
          { id: "tok-pc", actorId: "pc-1", name: "Fighter", hidden: false, x: 0, y: 0 },
          { id: "tok-gob", actorId: "gob-1", name: "Goblin", hidden: false, x: 100, y: 100 },
        ],
      },
    ],
    activeSceneId: "scene-1",
  });
}

describe("registerFoundrySystemTools", () => {
  it("registers the dnd5e write wrappers only when the system is dnd5e", () => {
    const dnd5e = new ToolRegistry();
    registerFoundrySystemTools(dnd5e, "dnd5e");
    expect(dnd5e.list().map((t) => t.name)).toEqual([
      "apply_damage",
      "heal",
      "start_combat",
      "end_combat",
      "next_turn",
      "spawn_token",
      "reveal_fog",
      "reset_fog",
    ]);

    // Unvalidated systems get no write wrappers (ADR-0012); the AI falls back
    // to narration plus the system-agnostic core tools.
    const fate = new ToolRegistry();
    registerFoundrySystemTools(fate, "fate-core");
    expect(fate.list()).toEqual([]);
  });

  it("every write wrapper is marked mutatesWorld for the write serializer", () => {
    for (const tool of DND5E_WRITE_TOOLS) {
      expect(tool.mutatesWorld, tool.name).toBe(true);
    }
  });
});

describe("apply_damage / heal", () => {
  it("apply_damage routes through FoundryClient.applyDamage and returns remaining HP", async () => {
    const { tenantDb, dispatcher } = bootstrap();
    const foundry = dnd5eWorld();
    const result = await dispatcher.dispatch(
      { name: "apply_damage", input: { actorId: "pc-1", amount: 7 } },
      ctx(tenantDb, foundry),
    );
    expect(result).toMatchObject({ ok: true, output: { hp: 5 } });
    expect(foundry.damageOps).toEqual([{ actorId: "pc-1", amount: 7 }]);
  });

  it("heal sends a negative amount and the client caps at max HP", async () => {
    const { tenantDb, dispatcher } = bootstrap();
    const foundry = dnd5eWorld();
    await dispatcher.dispatch(
      { name: "apply_damage", input: { actorId: "pc-1", amount: 7 } },
      ctx(tenantDb, foundry),
    );
    const healed = await dispatcher.dispatch(
      { name: "heal", input: { actorId: "pc-1", amount: 20 } },
      ctx(tenantDb, foundry),
    );
    expect(healed).toMatchObject({ ok: true, output: { hp: 12 } });
    expect(foundry.damageOps[1]).toEqual({ actorId: "pc-1", amount: -20 });
  });

  it("surfaces the client's not-found code for an unknown actor", async () => {
    const { tenantDb, dispatcher } = bootstrap();
    const result = await dispatcher.dispatch(
      { name: "apply_damage", input: { actorId: "fake-nobody", amount: 3 } },
      ctx(tenantDb, dnd5eWorld()),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("handler_error");
      expect(result.error).toContain("not-found");
    }
  });

  it("rejects a non-positive amount at the schema (heal is the negative path)", async () => {
    const { tenantDb, dispatcher } = bootstrap();
    const result = await dispatcher.dispatch(
      { name: "apply_damage", input: { actorId: "pc-1", amount: -4 } },
      ctx(tenantDb, dnd5eWorld()),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe("invalid_input");
  });

  it("fails with foundry-unavailable when the turn has no Foundry client", async () => {
    const { tenantDb, dispatcher } = bootstrap();
    const result = await dispatcher.dispatch(
      { name: "apply_damage", input: { actorId: "pc-1", amount: 3 } },
      ctx(tenantDb),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("foundry-unavailable");
  });
});

describe("start_combat / end_combat / next_turn", () => {
  it("start enrolls the active scene's tokens and a second start is idempotent", async () => {
    const { tenantDb, dispatcher } = bootstrap();
    const foundry = dnd5eWorld();
    const first = await dispatcher.dispatch(
      { name: "start_combat", input: {} },
      ctx(tenantDb, foundry),
    );
    expect(first.ok).toBe(true);
    const snapshot = (first as { output: { combatId: string; currentCombatantId: string } }).output;
    expect(snapshot.combatId).not.toBeNull();
    expect(snapshot.currentCombatantId).toBe("tok-pc");

    const second = await dispatcher.dispatch(
      { name: "start_combat", input: {} },
      ctx(tenantDb, foundry),
    );
    expect(second).toMatchObject({ ok: true, output: { combatId: snapshot.combatId } });
    expect(foundry.combatOps.map((op) => op.action)).toEqual(["start", "start"]);
  });

  it("next_turn advances the tracker and end_combat twice stays ok (combatId null)", async () => {
    const { tenantDb, dispatcher } = bootstrap();
    const foundry = dnd5eWorld();
    await dispatcher.dispatch({ name: "start_combat", input: {} }, ctx(tenantDb, foundry));
    const advanced = await dispatcher.dispatch(
      { name: "next_turn", input: {} },
      ctx(tenantDb, foundry),
    );
    expect(advanced).toMatchObject({ ok: true, output: { currentCombatantId: "tok-gob" } });

    const ended = await dispatcher.dispatch(
      { name: "end_combat", input: {} },
      ctx(tenantDb, foundry),
    );
    expect(ended).toMatchObject({ ok: true, output: { currentCombatantId: null } });
    const endedAgain = await dispatcher.dispatch(
      { name: "end_combat", input: {} },
      ctx(tenantDb, foundry),
    );
    expect(endedAgain).toMatchObject({ ok: true, output: { combatId: null } });
  });
});

describe("spawn_token", () => {
  it("places a token for a world actor at scene-pixel coordinates", async () => {
    const { tenantDb, dispatcher } = bootstrap();
    const foundry = dnd5eWorld();
    const result = await dispatcher.dispatch(
      { name: "spawn_token", input: { actorId: "gob-1", x: 400, y: 300, hidden: true } },
      ctx(tenantDb, foundry),
    );
    expect(result.ok).toBe(true);
    expect(foundry.createdTokens).toEqual([
      {
        tokenId: expect.stringContaining("tok-") as string,
        actorId: "gob-1",
        sceneId: "scene-1",
        x: 400,
        y: 300,
        hidden: true,
      },
    ]);
  });

  it("rejects a call with neither actorId nor compendiumRef at the schema", async () => {
    const { tenantDb, dispatcher } = bootstrap();
    const result = await dispatcher.dispatch(
      { name: "spawn_token", input: { x: 1, y: 1 } },
      ctx(tenantDb, dnd5eWorld()),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe("invalid_input");
  });
});

describe("reveal_fog / reset_fog", () => {
  it("defaults to the active scene and records the fog action", async () => {
    const { tenantDb, dispatcher } = bootstrap();
    const foundry = dnd5eWorld();
    const revealed = await dispatcher.dispatch(
      { name: "reveal_fog", input: {} },
      ctx(tenantDb, foundry),
    );
    expect(revealed).toMatchObject({ ok: true, output: { sceneId: "scene-1" } });

    const reset = await dispatcher.dispatch(
      { name: "reset_fog", input: { sceneId: "scene-1" } },
      ctx(tenantDb, foundry),
    );
    expect(reset).toMatchObject({ ok: true, output: { sceneId: "scene-1" } });
    expect(foundry.fogOps).toEqual([
      { action: "reveal-scene", sceneId: "scene-1" },
      { action: "reset", sceneId: "scene-1" },
    ]);
  });

  it("surfaces not-found for a scene that is not in the world", async () => {
    const { tenantDb, dispatcher } = bootstrap();
    const result = await dispatcher.dispatch(
      { name: "reveal_fog", input: { sceneId: "fake-missing" } },
      ctx(tenantDb, dnd5eWorld()),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("not-found");
  });
});
