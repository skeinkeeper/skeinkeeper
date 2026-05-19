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

  it("createDefaultRegistry registers the core (system-agnostic) tools", () => {
    const r = createDefaultRegistry();
    const names = r.list().map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "advance_time",
        "create_clock",
        "delete_clock",
        "fudge_roll",
        "move_party",
        "roll",
        "set_clock",
        "set_quest_flag",
        "tick_clock",
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
    await dispatcher.dispatch({ name: "advance_time", input: { campaignId: "c1", minutes: 15 } }, ctx);
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
      { name: "set_quest_flag", input: { campaignId: "c1", key: "cragmaw.cleared", value: "true" } },
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

  it("create_clock + tick_clock + set_clock + delete_clock", async () => {
    const { tenantDb, dispatcher } = bootstrap();
    const ctx = { tenantDb, sessionId: "s", turnId: "t", caller: "operator" as const };

    await dispatcher.dispatch(
      {
        name: "create_clock",
        input: { id: "clk-1", campaignId: "c1", name: "Threat", segmentsTotal: 4 },
      },
      ctx,
    );
    const tickRes = await dispatcher.dispatch(
      { name: "tick_clock", input: { id: "clk-1", segments: 2 } },
      ctx,
    );
    expect((tickRes.ok && (tickRes.output as { segmentsFilled: number }).segmentsFilled) || 0).toBe(2);

    const setRes = await dispatcher.dispatch(
      { name: "set_clock", input: { id: "clk-1", segmentsFilled: 4 } },
      ctx,
    );
    expect((setRes.ok && (setRes.output as { segmentsFilled: number }).segmentsFilled) || 0).toBe(4);

    await dispatcher.dispatch({ name: "delete_clock", input: { id: "clk-1" } }, ctx);
    expect(tenantDb.clocks.listByCampaign("c1")).toHaveLength(0);
  });
});

describe("rollFormula (legacy local roller)", () => {
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
