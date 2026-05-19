// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { describe, expect, it } from "vitest";
import { openDb, TenantDb, schema } from "@skeinkeeper/server";
import type { BehaviorSpec } from "./behavior.js";
import { MockFoundryClient } from "./foundry/mock.js";
import { FakeLLMProvider, fakeLlmFromEvents, type LLMEvent } from "./interfaces/index.js";
import { ToolDispatcher, ToolRegistry, defineTool } from "./registry.js";
import { runTurn, Session, type SessionConfig } from "./session.js";
import { z } from "zod";

const SPEC: BehaviorSpec = {
  content: "You are the AI DM. Behavior spec content here.",
  version: "v0.1",
  path: "/test/spec.md",
};

const DONE_USAGE = { inputTokens: 50, outputTokens: 25 };

function setupSession(overrides: Partial<SessionConfig> = {}): {
  session: Session;
  tenantDb: TenantDb;
} {
  const db = openDb({ path: ":memory:", runMigrations: true });
  db.insert(schema.tenants).values({ id: "default", name: "Test", createdAt: Date.now() }).run();
  db.insert(schema.campaigns)
    .values({
      id: "c1",
      tenantId: "default",
      name: "Test Campaign",
      rulesetId: "dnd5e",
      behaviorSpecVersion: "v0.1",
      status: "active",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    .run();
  const tenantDb = new TenantDb(db, "default");

  const registry = new ToolRegistry();
  const dispatcher = new ToolDispatcher({ registry });
  const llm = overrides.llm ?? fakeLlmFromEvents([
    { kind: "text_delta", text: "Default narration." },
    { kind: "done", stopReason: "end_turn", usage: DONE_USAGE },
  ]);

  const config: SessionConfig = {
    sessionId: "sess-1",
    campaignId: "c1",
    behaviorSpec: SPEC,
    llm,
    dispatcher,
    foundry: new MockFoundryClient({ system: "dnd5e" }),
    tenantDb,
    ...overrides,
  };
  return { session: new Session(config), tenantDb };
}

function registerToolThatRecordsName(
  session: Session,
  name: string,
  out: { result?: string },
): void {
  const tool = defineTool({
    name,
    description: `Test tool ${name}.`,
    inputSchema: z.object({ note: z.string().optional() }),
    outputSchema: z.object({ recorded: z.string() }),
    async handle(input) {
      out.result = input.note ?? "called";
      return { recorded: out.result };
    },
  });
  session.config.dispatcher.registry().register(tool);
}

describe("runTurn — single iteration (no tool calls)", () => {
  it("accumulates text_delta events into narration and terminates with end_turn", async () => {
    const { session, tenantDb } = setupSession({
      llm: fakeLlmFromEvents([
        { kind: "text_delta", text: "The road is " },
        { kind: "text_delta", text: "dusty." },
        { kind: "done", stopReason: "end_turn", usage: DONE_USAGE },
      ]),
    });
    const out = await runTurn(session, { speaker: "player1", text: "I look around." });
    expect(out.narration).toBe("The road is dusty.");
    expect(out.toolCalls).toEqual([]);
    expect(out.stopReason).toBe("end_turn");
    expect(out.iterations).toBe(1);

    // Audit log: turn_started + turn_completed = 2 rows
    const audit = tenantDb.auditLog.listForSession("sess-1");
    expect(audit).toHaveLength(2);
    expect(audit[0]?.eventType).toBe("turn_started");
    expect(audit[1]?.eventType).toBe("turn_completed");
  });

  it("appends the player turn to session.dialogue", async () => {
    const { session } = setupSession();
    await runTurn(session, { speaker: "player1", displayName: "Aragorn", text: "Hello." });
    expect(session.dialogue).toHaveLength(1);
    expect(session.dialogue[0]?.speaker).toBe("player1");
    expect(session.dialogue[0]?.displayName).toBe("Aragorn");
    expect(session.dialogue[0]?.text).toBe("Hello.");
  });

  it("sends the behavior spec as the system prompt", async () => {
    const provider = fakeLlmFromEvents([
      { kind: "text_delta", text: "ok" },
      { kind: "done", stopReason: "end_turn", usage: DONE_USAGE },
    ]);
    const { session } = setupSession({ llm: provider });
    await runTurn(session, { speaker: "p", text: "hi" });
    expect(provider.receivedRequests[0]?.systemPrompt).toBe(SPEC.content);
  });

  it("includes hot context (the dialogue turn) in the first user message", async () => {
    const provider = fakeLlmFromEvents([
      { kind: "text_delta", text: "ok" },
      { kind: "done", stopReason: "end_turn", usage: DONE_USAGE },
    ]);
    const { session } = setupSession({ llm: provider });
    await runTurn(session, { speaker: "player1", displayName: "Aragorn", text: "I look around." });
    const msg = provider.receivedRequests[0]?.messages[0];
    expect(msg?.role).toBe("user");
    const text = msg?.content[0]?.type === "text" ? msg.content[0].text : "";
    expect(text).toContain("I look around.");
    expect(text).toContain("Aragorn"); // displayName surfaces in dialogue rendering
  });
});

describe("runTurn — multi-iteration tool dispatch", () => {
  it("dispatches a tool call and feeds the result back to the model", async () => {
    const toolResult: { result?: string } = {};
    const events: LLMEvent[][] = [
      // Iteration 1: text + one tool_call
      [
        { kind: "text_delta", text: "Roll perception. " },
        { kind: "tool_call", id: "tu_1", name: "test_perception", input: { note: "rolled" } },
        { kind: "done", stopReason: "tool_use", usage: DONE_USAGE },
      ],
      // Iteration 2: final text after seeing tool_result
      [
        { kind: "text_delta", text: "You notice a hidden door." },
        { kind: "done", stopReason: "end_turn", usage: DONE_USAGE },
      ],
    ];
    const provider = new FakeLLMProvider([
      { match: (r) => r.messages.length === 1, events: events[0]! },
      { match: (r) => r.messages.length === 3, events: events[1]! },
    ]);

    const { session, tenantDb } = setupSession({ llm: provider });
    registerToolThatRecordsName(session, "test_perception", toolResult);

    const out = await runTurn(session, { speaker: "p", text: "I look for traps." });
    expect(out.narration).toBe("Roll perception. You notice a hidden door.");
    expect(out.toolCalls).toHaveLength(1);
    expect(out.toolCalls[0]?.name).toBe("test_perception");
    expect(out.toolCalls[0]?.ok).toBe(true);
    expect(out.stopReason).toBe("end_turn");
    expect(out.iterations).toBe(2);
    expect(toolResult.result).toBe("rolled");

    // Audit log: turn_started + tool_called + turn_completed = 3 rows
    const audit = tenantDb.auditLog.listForSession("sess-1");
    expect(audit.map((e) => e.eventType)).toEqual([
      "turn_started",
      "tool_called",
      "turn_completed",
    ]);
  });

  it("handles multiple tool calls within one iteration", async () => {
    const r1: { result?: string } = {};
    const r2: { result?: string } = {};
    const provider = new FakeLLMProvider([
      {
        match: (r) => r.messages.length === 1,
        events: [
          { kind: "tool_call", id: "tu_1", name: "tool_a", input: { note: "first" } },
          { kind: "tool_call", id: "tu_2", name: "tool_b", input: { note: "second" } },
          { kind: "done", stopReason: "tool_use", usage: DONE_USAGE },
        ],
      },
      {
        match: (r) => r.messages.length === 3,
        events: [
          { kind: "text_delta", text: "Both done." },
          { kind: "done", stopReason: "end_turn", usage: DONE_USAGE },
        ],
      },
    ]);
    const { session } = setupSession({ llm: provider });
    registerToolThatRecordsName(session, "tool_a", r1);
    registerToolThatRecordsName(session, "tool_b", r2);

    const out = await runTurn(session, { speaker: "p", text: "do both" });
    expect(out.toolCalls).toHaveLength(2);
    expect(out.toolCalls[0]?.name).toBe("tool_a");
    expect(out.toolCalls[1]?.name).toBe("tool_b");
    expect(r1.result).toBe("first");
    expect(r2.result).toBe("second");
    expect(out.iterations).toBe(2);
  });

  it("captures tool failures and feeds them back to the model as isError tool_results", async () => {
    const provider = new FakeLLMProvider([
      {
        match: (r) => r.messages.length === 1,
        events: [
          { kind: "tool_call", id: "tu_1", name: "nonexistent_tool", input: {} },
          { kind: "done", stopReason: "tool_use", usage: DONE_USAGE },
        ],
      },
      {
        match: (r) => r.messages.length === 3,
        events: [
          { kind: "text_delta", text: "I see the tool failed; continuing without it." },
          { kind: "done", stopReason: "end_turn", usage: DONE_USAGE },
        ],
      },
    ]);
    const { session } = setupSession({ llm: provider });
    const out = await runTurn(session, { speaker: "p", text: "try a bad tool" });
    expect(out.toolCalls).toHaveLength(1);
    expect(out.toolCalls[0]?.ok).toBe(false);
    expect(out.stopReason).toBe("end_turn");

    // Verify the second LLM request received an isError tool_result block.
    const req2 = provider.receivedRequests[1];
    const lastMsg = req2?.messages[req2.messages.length - 1];
    expect(lastMsg?.role).toBe("user");
    const tr = lastMsg?.content[0];
    expect(tr?.type).toBe("tool_result");
    if (tr?.type === "tool_result") {
      expect(tr.isError).toBe(true);
    }
  });
});

describe("runTurn — termination conditions", () => {
  it("returns llm_error stopReason when the provider yields an error event", async () => {
    const { session } = setupSession({
      llm: fakeLlmFromEvents([
        { kind: "text_delta", text: "Partial..." },
        { kind: "error", error: { kind: "overloaded", message: "529" } },
      ]),
    });
    const out = await runTurn(session, { speaker: "p", text: "hi" });
    expect(out.stopReason).toBe("llm_error");
    expect(out.errorMessage).toContain("overloaded");
    expect(out.narration).toBe("Partial...");
  });

  it("hits max_tool_iterations when the model keeps emitting tool calls", async () => {
    // Same script every iteration: always emit one tool_call, never terminate.
    const provider = new FakeLLMProvider([
      {
        events: [
          { kind: "tool_call", id: "tu_x", name: "infinite_loop_tool", input: {} },
          { kind: "done", stopReason: "tool_use", usage: DONE_USAGE },
        ],
      },
    ]);
    const { session } = setupSession({ llm: provider, maxToolIterations: 3 });
    registerToolThatRecordsName(session, "infinite_loop_tool", {});

    const out = await runTurn(session, { speaker: "p", text: "loop" });
    expect(out.stopReason).toBe("max_tool_iterations");
    expect(out.iterations).toBe(3);
    expect(out.toolCalls).toHaveLength(3);
  });
});

describe("runTurn — audit log", () => {
  it("records turn_started with a text hash (not the raw player text)", async () => {
    const { session, tenantDb } = setupSession();
    await runTurn(session, { speaker: "p", text: "secret player line" });
    const start = tenantDb.auditLog.listForSession("sess-1")[0]!;
    const payload = JSON.parse(start.payloadJson) as { textHash?: string };
    expect(payload.textHash).toMatch(/^[0-9a-f]{12}$/);
    expect(start.payloadJson).not.toContain("secret player line");
  });

  it("records turn_completed with stopReason + iterations + toolCallCount", async () => {
    const { session, tenantDb } = setupSession();
    await runTurn(session, { speaker: "p", text: "hi" });
    const rows = tenantDb.auditLog.listForSession("sess-1");
    const end = rows[rows.length - 1]!;
    expect(end.eventType).toBe("turn_completed");
    const payload = JSON.parse(end.payloadJson) as {
      stopReason: string;
      iterations: number;
      toolCallCount: number;
    };
    expect(payload.stopReason).toBe("end_turn");
    expect(payload.iterations).toBe(1);
    expect(payload.toolCallCount).toBe(0);
  });
});
