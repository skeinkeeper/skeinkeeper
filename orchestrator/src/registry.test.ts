// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { describe, expect, it, vi, beforeEach } from "vitest";
import { z } from "zod";
import { openDb, TenantDb, schema } from "@skeinkeeper/server";
import { ToolRegistry, ToolDispatcher, defineTool } from "./registry.js";
import { createDefaultRegistry } from "./tools/index.js";

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

  it("createDefaultRegistry registers all 12 builtin tools", () => {
    const r = createDefaultRegistry();
    const names = r.list().map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "advance_time",
        "apply_damage",
        "clear_condition",
        "fudge_roll",
        "heal",
        "move_party",
        "roll",
        "set_condition",
        "set_quest_flag",
        "update_inventory",
        "update_npc_disposition",
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

  function makeCtx(tenantDb: TenantDb, overrides: Partial<{ caller: "llm" | "operator"; flags: { fudgeAllowed?: boolean } }> = {}) {
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

    expect(analytics.track).toHaveBeenCalledWith("tool.called", expect.objectContaining({
      toolName: "echo",
      success: true,
    }));
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
    const result = await d.dispatch({ name: "echo", input: {} }, makeCtx(tenantDb, { caller: "operator" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe("invalid_input");
  });

  it("rejects operator-gated tool when invoked by LLM without flag", async () => {
    const { tenantDb } = setup();
    const r = createDefaultRegistry();
    const d = new ToolDispatcher({ registry: r });
    const result = await d.dispatch(
      { name: "fudge_roll", input: { originalTotal: 1, newTotal: 20, reason: "saving the story arc" } },
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
      { name: "fudge_roll", input: { originalTotal: 1, newTotal: 20, reason: "saving the story arc" } },
      makeCtx(tenantDb, { caller: "operator" }),
    );
    expect(result.ok).toBe(true);
  });

  it("allows fudge_roll for LLM when fudgeAllowed flag is set", async () => {
    const { tenantDb } = setup();
    const r = createDefaultRegistry();
    const d = new ToolDispatcher({ registry: r });
    const result = await d.dispatch(
      { name: "fudge_roll", input: { originalTotal: 1, newTotal: 20, reason: "string of bad luck" } },
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
    const result = await d.dispatch({ name: "throw", input: { x: 1 } }, makeCtx(tenantDb, { caller: "operator" }));
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
    db.insert(schema.characters)
      .values({
        id: "char-1",
        tenantId: "default",
        campaignId: "c1",
        name: "Aragorn",
        playerDiscordId: "discord:111",
        hp: 20,
        maxHp: 30,
        rulesetDataJson: "{}",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      .run();
    return { tenantDb, dispatcher: new ToolDispatcher({ registry: createDefaultRegistry() }) };
  }

  it("apply_damage and heal clamp correctly", async () => {
    const { tenantDb, dispatcher } = bootstrap();
    const ctx = {
      tenantDb,
      sessionId: "s",
      turnId: "t",
      caller: "operator" as const,
    };
    const dmg = await dispatcher.dispatch(
      { name: "apply_damage", input: { characterId: "char-1", amount: 50 } },
      ctx,
    );
    expect(dmg.ok).toBe(true);
    if (dmg.ok) expect((dmg.output as { after: number }).after).toBe(0);

    const heal = await dispatcher.dispatch(
      { name: "heal", input: { characterId: "char-1", amount: 100 } },
      ctx,
    );
    expect(heal.ok).toBe(true);
    if (heal.ok) expect((heal.output as { after: number }).after).toBe(30); // capped at maxHp
  });

  it("set/clear_condition round-trips the conditions list", async () => {
    const { tenantDb, dispatcher } = bootstrap();
    const ctx = { tenantDb, sessionId: "s", turnId: "t", caller: "operator" as const };
    await dispatcher.dispatch(
      { name: "set_condition", input: { characterId: "char-1", condition: "frightened" } },
      ctx,
    );
    const setRes = await dispatcher.dispatch(
      { name: "set_condition", input: { characterId: "char-1", condition: "prone" } },
      ctx,
    );
    expect((setRes.ok && (setRes.output as { conditions: string[] }).conditions) || []).toEqual([
      "frightened",
      "prone",
    ]);
    const clearRes = await dispatcher.dispatch(
      { name: "clear_condition", input: { characterId: "char-1", condition: "frightened" } },
      ctx,
    );
    expect((clearRes.ok && (clearRes.output as { conditions: string[] }).conditions) || []).toEqual([
      "prone",
    ]);
  });

  it("advance_time accumulates across calls", async () => {
    const { tenantDb, dispatcher } = bootstrap();
    const ctx = { tenantDb, sessionId: "s", turnId: "t", caller: "operator" as const };
    await dispatcher.dispatch({ name: "advance_time", input: { campaignId: "c1", minutes: 15 } }, ctx);
    const r = await dispatcher.dispatch(
      { name: "advance_time", input: { campaignId: "c1", minutes: 30 } },
      ctx,
    );
    expect((r.ok && (r.output as { minutesElapsed: number }).minutesElapsed) || 0).toBe(45);
  });
});

describe("rollFormula", () => {
  it("rolls within bounds", async () => {
    const { rollFormula } = await import("./dice.js");
    for (let i = 0; i < 20; i++) {
      const r = rollFormula("1d20+3");
      expect(r.dice).toHaveLength(1);
      expect(r.dice[0]!).toBeGreaterThanOrEqual(1);
      expect(r.dice[0]!).toBeLessThanOrEqual(20);
      expect(r.total).toBe(r.dice[0]! + 3);
    }
  });

  it("supports advantage and disadvantage", async () => {
    const { rollFormula } = await import("./dice.js");
    expect(rollFormula("1d20", { advantage: true }).advantage).toBe(true);
    expect(rollFormula("1d20", { disadvantage: true }).advantage).toBe(false);
  });

  it("rejects bad formulas", async () => {
    const { rollFormula } = await import("./dice.js");
    expect(() => rollFormula("garbage")).toThrow();
  });
});
