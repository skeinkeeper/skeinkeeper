// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { describe, expect, it, vi, beforeEach } from "vitest";
import { z } from "zod";
import { openDb, TenantDb, schema } from "@skeinkeeper/server";
import { ToolRegistry, ToolDispatcher, defineTool } from "./registry.js";
import { createDefaultRegistry } from "./tools/index.js";
import { MockFoundryClient } from "./foundry/mock.js";
import { Mutex } from "./util/mutex.js";

function setup() {
  const db = openDb({ path: ":memory:", runMigrations: true });
  db.insert(schema.tenants).values({ id: "default", name: "Test", createdAt: Date.now() }).run();
  const tenantDb = new TenantDb(db, "default");
  return { db, tenantDb };
}

const echoTool = defineTool({
  name: "echo",
  description: "Echo back the message.",
  inputSchema: z.object({ msg: z.string() }),
  outputSchema: z.object({ echoed: z.string() }),
  async handle(input) {
    return { echoed: input.msg };
  },
});

describe("ToolRegistry", () => {
  it("registers and looks up tools", () => {
    const r = new ToolRegistry();
    r.register(echoTool);
    expect(r.get("echo")?.name).toBe("echo");
    expect(r.list()).toHaveLength(1);
  });

  it("rejects duplicate registration", () => {
    const r = new ToolRegistry();
    r.register(echoTool);
    expect(() => r.register(echoTool)).toThrow(/already registered/);
  });

  it("createDefaultRegistry registers the core (system-agnostic) tools", () => {
    const r = createDefaultRegistry();
    const names = r
      .list()
      .map((t) => t.name)
      .sort();
    expect(names).toEqual(
      [
        "advance_time",
        "distribute_loot",
        "fudge_roll",
        "hide_token",
        "move_party",
        "notify_operator",
        "place_hidden_token",
        "record_player_character",
        "reveal_token",
        "roll",
        "set_quest_flag",
        "share_journal_to_audience",
        "whisper",
      ].sort(),
    );
  });
});

describe("ToolDispatcher", () => {
  let analytics: { track: ReturnType<typeof vi.fn>; flush: ReturnType<typeof vi.fn> };
  beforeEach(() => {
    analytics = { track: vi.fn(), flush: vi.fn().mockResolvedValue(undefined) };
  });

  function makeCtx(
    tenantDb: TenantDb,
    overrides: Partial<{ caller: "llm" | "operator"; flags: { fudgeAllowed?: boolean } }> = {},
  ) {
    return {
      tenantDb,
      sessionId: "sess-1",
      turnId: "turn-1",
      caller: overrides.caller ?? "llm",
      ...(overrides.flags !== undefined ? { flags: overrides.flags } : {}),
    } as const;
  }

  it("dispatches a successful call and writes an audit-log row", async () => {
    const { tenantDb } = setup();
    const r = new ToolRegistry();
    r.register(echoTool);
    const d = new ToolDispatcher({ registry: r, analytics });

    const result = await d.dispatch(
      { name: "echo", input: { msg: "hi" } },
      makeCtx(tenantDb, { caller: "operator" }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect((result.output as { echoed: string }).echoed).toBe("hi");

    const entries = tenantDb.auditLog.listForSession("sess-1");
    expect(entries).toHaveLength(1);
    expect(entries[0]?.actor).toBe("tool:echo");
    expect(entries[0]?.eventType).toBe("tool_called");

    expect(analytics.track).toHaveBeenCalledWith(
      "tool.called",
      expect.objectContaining({ toolName: "echo", success: true }),
    );
  });

  it("reports unknown_tool without crashing", async () => {
    const { tenantDb } = setup();
    const d = new ToolDispatcher({ registry: new ToolRegistry() });
    const result = await d.dispatch({ name: "nope", input: {} }, makeCtx(tenantDb));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe("unknown_tool");
  });

  it("reports invalid_input with the Zod error", async () => {
    const { tenantDb } = setup();
    const r = new ToolRegistry();
    r.register(echoTool);
    const d = new ToolDispatcher({ registry: r });
    const result = await d.dispatch(
      { name: "echo", input: {} },
      makeCtx(tenantDb, { caller: "operator" }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe("invalid_input");
  });

  it("rejects operator-gated tool when invoked by LLM without flag", async () => {
    const { tenantDb } = setup();
    const r = createDefaultRegistry();
    const d = new ToolDispatcher({ registry: r });
    const result = await d.dispatch(
      {
        name: "fudge_roll",
        input: { originalTotal: 1, newTotal: 20, reason: "saving the story arc" },
      },
      makeCtx(tenantDb, { caller: "llm" }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe("operator_gated");
  });

  it("allows operator-gated tool when caller is operator", async () => {
    const { tenantDb } = setup();
    const r = createDefaultRegistry();
    const d = new ToolDispatcher({ registry: r });
    const result = await d.dispatch(
      {
        name: "fudge_roll",
        input: { originalTotal: 1, newTotal: 20, reason: "saving the story arc" },
      },
      makeCtx(tenantDb, { caller: "operator" }),
    );
    expect(result.ok).toBe(true);
  });

  it("allows fudge_roll for LLM when fudgeAllowed flag is set", async () => {
    const { tenantDb } = setup();
    const r = createDefaultRegistry();
    const d = new ToolDispatcher({ registry: r });
    const result = await d.dispatch(
      {
        name: "fudge_roll",
        input: { originalTotal: 1, newTotal: 20, reason: "string of bad luck" },
      },
      makeCtx(tenantDb, { caller: "llm", flags: { fudgeAllowed: true } }),
    );
    expect(result.ok).toBe(true);
  });

  it("captures handler_error and reports message", async () => {
    const { tenantDb } = setup();
    const throwTool = defineTool({
      name: "throw",
      description: "always throws",
      inputSchema: z.object({ x: z.number() }),
      outputSchema: z.object({ y: z.number() }),
      async handle() {
        throw new Error("nope");
      },
    });
    const r = new ToolRegistry();
    r.register(throwTool);
    const d = new ToolDispatcher({ registry: r });
    const result = await d.dispatch(
      { name: "throw", input: { x: 1 } },
      makeCtx(tenantDb, { caller: "operator" }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("handler_error");
      expect(result.error).toContain("nope");
    }
  });
});

describe("Builtin tools (end-to-end)", () => {
  function bootstrap() {
    const { db, tenantDb } = setup();
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
    return { tenantDb, dispatcher: new ToolDispatcher({ registry: createDefaultRegistry() }) };
  }

  it("advance_time accumulates across calls", async () => {
    const { tenantDb, dispatcher } = bootstrap();
    const ctx = { tenantDb, sessionId: "s", turnId: "t", caller: "operator" as const };
    await dispatcher.dispatch(
      { name: "advance_time", input: { campaignId: "c1", minutes: 15 } },
      ctx,
    );
    const r = await dispatcher.dispatch(
      { name: "advance_time", input: { campaignId: "c1", minutes: 30 } },
      ctx,
    );
    expect((r.ok && (r.output as { minutesElapsed: number }).minutesElapsed) || 0).toBe(45);
  });

  it("set_quest_flag persists and move_party records party.location", async () => {
    const { tenantDb, dispatcher } = bootstrap();
    const ctx = { tenantDb, sessionId: "s", turnId: "t", caller: "operator" as const };
    await dispatcher.dispatch(
      {
        name: "set_quest_flag",
        input: { campaignId: "c1", key: "cragmaw.cleared", value: "true" },
      },
      ctx,
    );
    await dispatcher.dispatch(
      { name: "move_party", input: { campaignId: "c1", locationId: "scene-tavern" } },
      ctx,
    );
    const flags = tenantDb.questFlags.listByCampaign("c1");
    expect(flags.map((f) => f.key).sort()).toEqual(["cragmaw.cleared", "party.location"]);
    expect(flags.find((f) => f.key === "party.location")?.value).toBe("scene-tavern");
  });

  it("record_player_character persists a player-sourced mapping", async () => {
    const { tenantDb, dispatcher } = bootstrap();
    const ctx = { tenantDb, sessionId: "s", turnId: "t", caller: "llm" as const };
    const r = await dispatcher.dispatch(
      {
        name: "record_player_character",
        input: {
          campaignId: "c1",
          discordUserId: "discord:alice",
          foundryActorId: "actor-alice",
          displayName: "Alice the Bold",
        },
      },
      ctx,
    );
    expect(r.ok).toBe(true);
    const current = tenantDb.playerCharacterMap.currentForPlayer("c1", "discord:alice");
    expect(current?.foundryActorId).toBe("actor-alice");
    expect(current?.source).toBe("player");
    expect(current?.displayName).toBe("Alice the Bold");
  });

  it("notify_operator delivers via ctx.notifyOperator", async () => {
    const { tenantDb, dispatcher } = bootstrap();
    const sent: string[] = [];
    const ctx = {
      tenantDb,
      sessionId: "s",
      turnId: "t",
      caller: "llm" as const,
      notifyOperator: async (m: string) => {
        sent.push(m);
      },
    };
    const r = await dispatcher.dispatch(
      { name: "notify_operator", input: { message: "I can't find an actor named Mirna." } },
      ctx,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.output as { delivered: boolean }).delivered).toBe(true);
    expect(sent).toEqual(["I can't find an actor named Mirna."]);
  });

  it("notify_operator reports undelivered when no operator channel is wired", async () => {
    const { tenantDb, dispatcher } = bootstrap();
    const ctx = { tenantDb, sessionId: "s", turnId: "t", caller: "llm" as const };
    const r = await dispatcher.dispatch(
      { name: "notify_operator", input: { message: "Foundry seems disconnected." } },
      ctx,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.output as { delivered: boolean }).delivered).toBe(false);
  });
});

describe("ToolDispatcher — write serialization (design doc 0026 §3)", () => {
  const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

  function slowTool(name: string, events: string[], mutatesWorld: boolean, delay: number) {
    return defineTool({
      name,
      description: name,
      mutatesWorld,
      inputSchema: z.object({}),
      outputSchema: z.object({ ok: z.boolean() }),
      async handle() {
        events.push(`${name}:start`);
        await tick(delay);
        events.push(`${name}:end`);
        return { ok: true };
      },
    });
  }

  const ctx = (tenantDb: TenantDb) =>
    ({ tenantDb, sessionId: "s", turnId: "t", caller: "operator" as const }) as const;

  it("serializes mutatesWorld handlers FIFO through the writeSerializer", async () => {
    const { tenantDb } = setup();
    const events: string[] = [];
    const r = new ToolRegistry();
    r.register(slowTool("w1", events, true, 30));
    r.register(slowTool("w2", events, true, 5));
    const d = new ToolDispatcher({ registry: r, writeSerializer: new Mutex() });

    await Promise.all([
      d.dispatch({ name: "w1", input: {} }, ctx(tenantDb)),
      d.dispatch({ name: "w2", input: {} }, ctx(tenantDb)),
    ]);

    // w1 (slower) was dispatched first, so it commits first despite the delay.
    expect(events).toEqual(["w1:start", "w1:end", "w2:start", "w2:end"]);
  });

  it("does not serialize read-only handlers — they bypass the lock", async () => {
    const { tenantDb } = setup();
    const events: string[] = [];
    const r = new ToolRegistry();
    r.register(slowTool("writer", events, true, 30)); // holds the lock 30ms
    r.register(slowTool("reader", events, false, 0)); // read-only, immediate
    const d = new ToolDispatcher({ registry: r, writeSerializer: new Mutex() });

    await Promise.all([
      d.dispatch({ name: "writer", input: {} }, ctx(tenantDb)),
      d.dispatch({ name: "reader", input: {} }, ctx(tenantDb)),
    ]);

    // The reader finished before the slow writer — it did not wait for the lock.
    expect(events.indexOf("reader:end")).toBeLessThan(events.indexOf("writer:end"));
  });

  it("without a writeSerializer, mutating handlers may overlap (legacy single-table flow)", async () => {
    const { tenantDb } = setup();
    const events: string[] = [];
    const r = new ToolRegistry();
    r.register(slowTool("w1", events, true, 30));
    r.register(slowTool("w2", events, true, 5));
    const d = new ToolDispatcher({ registry: r }); // no serializer

    await Promise.all([
      d.dispatch({ name: "w1", input: {} }, ctx(tenantDb)),
      d.dispatch({ name: "w2", input: {} }, ctx(tenantDb)),
    ]);

    // Unserialized: the faster w2 finishes before w1 (they overlapped).
    expect(events).toEqual(["w1:start", "w2:start", "w2:end", "w1:end"]);
  });
});

// (rollFormula is comprehensively tested in dice.test.ts.)

describe("roll tool", () => {
  function bootstrap() {
    const { db, tenantDb } = setup();
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
    return { tenantDb, dispatcher: new ToolDispatcher({ registry: createDefaultRegistry() }) };
  }

  it("rolls via the local roller when no Foundry is present (real dice, not a no-op)", async () => {
    const { tenantDb, dispatcher } = bootstrap();
    const ctx = { tenantDb, sessionId: "s", turnId: "t", caller: "llm" as const };
    const r = await dispatcher.dispatch({ name: "roll", input: { formula: "1d20+3" } }, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const out = r.output as { total: number; rolls: number[] };
      expect(out.rolls).toHaveLength(1);
      expect(out.total).toBe(out.rolls[0]! + 3);
      expect(out.total).toBeGreaterThanOrEqual(4);
    }
  });

  it("delegates to the Foundry roller when present", async () => {
    const { tenantDb, dispatcher } = bootstrap();
    const foundry = new MockFoundryClient({ system: "dnd5e" });
    const ctx = { tenantDb, sessionId: "s", turnId: "t", caller: "llm" as const, foundry };
    const r = await dispatcher.dispatch(
      { name: "roll", input: { formula: "2d6", speaker: "Aragorn" } },
      ctx,
    );
    expect(r.ok).toBe(true);
    // The mock records the roll it was asked to make.
    expect(foundry.rolls.map((x) => x.formula)).toContain("2d6");
  });
});

describe("move_party — activates the Foundry scene (ADR-0015)", () => {
  function bootstrapWithCampaign() {
    const { db, tenantDb } = setup();
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
    return { tenantDb, dispatcher: new ToolDispatcher({ registry: createDefaultRegistry() }) };
  }

  it("switches the active scene by name and reports sceneActivated", async () => {
    const { tenantDb, dispatcher } = bootstrapWithCampaign();
    const foundry = new MockFoundryClient({
      system: "dnd5e",
      scenes: [
        { id: "s-inn", name: "Stonehill Inn", active: true, tokens: [] },
        { id: "s-cragmaw", name: "Cragmaw Hideout", active: false, tokens: [] },
      ],
      activeSceneId: "s-inn",
    });
    const ctx = { tenantDb, sessionId: "s", turnId: "t", caller: "llm" as const, foundry };

    const r = await dispatcher.dispatch(
      { name: "move_party", input: { campaignId: "c1", locationId: "Cragmaw Hideout" } },
      ctx,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.output as { sceneActivated: boolean }).sceneActivated).toBe(true);
    expect((await foundry.getActiveScene())?.id).toBe("s-cragmaw");
    // quest flag still recorded
    expect(
      tenantDb.questFlags.listByCampaign("c1").find((f) => f.key === "party.location")?.value,
    ).toBe("Cragmaw Hideout");
  });

  it("still records the flag when no Foundry is in context (sceneActivated false)", async () => {
    const { tenantDb, dispatcher } = bootstrapWithCampaign();
    const ctx = { tenantDb, sessionId: "s", turnId: "t", caller: "llm" as const };
    const r = await dispatcher.dispatch(
      { name: "move_party", input: { campaignId: "c1", locationId: "somewhere" } },
      ctx,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.output as { sceneActivated: boolean }).sceneActivated).toBe(false);
  });
});
