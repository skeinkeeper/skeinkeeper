// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { describe, expect, it } from "vitest";
import { openDb, TenantDb, schema } from "@skeinkeeper/server";
import type { BehaviorSpec } from "./behavior.js";
import { MockFoundryClient } from "./foundry/mock.js";
import {
  FakeEmbeddingProvider,
  FakeLLMProvider,
  fakeLlmFromEvents,
  type LLMEvent,
} from "./interfaces/index.js";
import { InMemoryMemoryStore } from "./memory/store.js";
import { ToolDispatcher, ToolRegistry, defineTool } from "./registry.js";
import {
  archiveSession,
  endSession,
  runTurn,
  startSession,
  Session,
  type SessionConfig,
} from "./session.js";
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
  const llm =
    overrides.llm ??
    fakeLlmFromEvents([
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
  // startSession creates the session row that runTurn's dialogue inserts
  // FK-reference.
  return { session: startSession(config), tenantDb };
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

  it("appends the player turn (then the narrator turn) to session.dialogue", async () => {
    const { session } = setupSession();
    await runTurn(session, { speaker: "player1", displayName: "Aragorn", text: "Hello." });
    // Player turn first, then the AI's narration as a narrator turn.
    expect(session.dialogue[0]?.speaker).toBe("player1");
    expect(session.dialogue[0]?.displayName).toBe("Aragorn");
    expect(session.dialogue[0]?.text).toBe("Hello.");
    expect(session.dialogue.some((d) => d.speaker === "narrator")).toBe(true);
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

describe("telemetry emission (design doc 0009 / audit wave 3)", () => {
  function recordingAnalytics(): {
    analytics: { track: (n: string, p: unknown) => void; flush: () => Promise<void> };
    events: Array<{ name: string; props: Record<string, unknown> }>;
  } {
    const events: Array<{ name: string; props: Record<string, unknown> }> = [];
    return {
      analytics: {
        track: (name, props) => events.push({ name, props: props as Record<string, unknown> }),
        flush: async () => {},
      },
      events,
    };
  }

  it("emits behavior_spec.loaded + session.started on startSession", () => {
    const { analytics, events } = recordingAnalytics();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test fake analytics
    setupSession({ analytics: analytics as any });
    const names = events.map((e) => e.name);
    expect(names).toContain("session.started");
    expect(names).toContain("behavior_spec.loaded");
    const spec = events.find((e) => e.name === "behavior_spec.loaded")!;
    expect(spec.props.version).toBe("v0.1");
    expect(typeof spec.props.sizeKbBucket).toBe("string");
  });

  it("emits llm.completed for a narration turn (bucketed, no content)", async () => {
    const { analytics, events } = recordingAnalytics();
    const { session } = setupSession({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test fake analytics
      analytics: analytics as any,
      llm: fakeLlmFromEvents([
        { kind: "text_delta", text: "Narrate." },
        { kind: "done", stopReason: "end_turn", usage: DONE_USAGE },
      ]),
    });
    await runTurn(session, { speaker: "p", text: "hi" });
    const llm = events.find((e) => e.name === "llm.completed");
    expect(llm).toBeDefined();
    expect(llm!.props.modelTier).toBe("narration");
    expect(llm!.props.success).toBe(true);
    expect(llm!.props.stopReason).toBe("end_turn");
    expect(typeof llm!.props.inputTokensBucket).toBe("string");
    // No prompt/response content in the props.
    expect(JSON.stringify(llm!.props)).not.toContain("Narrate");
  });

  it("emits error.captured when the LLM errors", async () => {
    const { analytics, events } = recordingAnalytics();
    const { session } = setupSession({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test fake analytics
      analytics: analytics as any,
      llm: fakeLlmFromEvents([
        { kind: "error", error: { kind: "rate_limited", message: "slow down" } },
      ]),
    });
    const out = await runTurn(session, { speaker: "p", text: "hi" });
    expect(out.stopReason).toBe("llm_error");
    const err = events.find((e) => e.name === "error.captured");
    expect(err?.props.errorClass).toBe("rate_limited");
    expect(err?.props.module).toBe("orchestrator:run_turn");
  });
});

describe("runTurn — warm-state build count (perf)", () => {
  // Wrap MockFoundryClient and count listPartyActors, which buildWarmStateSnapshot
  // calls exactly once per build. So the count == number of warm-state builds.
  function countingFoundry(): { foundry: MockFoundryClient; partyReads: () => number } {
    const inner = new MockFoundryClient({ system: "dnd5e" });
    let n = 0;
    const orig = inner.listPartyActors.bind(inner);
    inner.listPartyActors = async () => {
      n += 1;
      return orig();
    };
    return { foundry: inner, partyReads: () => n };
  }

  it("builds warm state once on a pure-narration turn (no second rebuild)", async () => {
    const { foundry, partyReads } = countingFoundry();
    const { session } = setupSession({
      foundry,
      llm: fakeLlmFromEvents([
        { kind: "text_delta", text: "The road is quiet." },
        { kind: "done", stopReason: "end_turn", usage: DONE_USAGE },
      ]),
    });
    await runTurn(session, { speaker: "p", text: "I look around." });
    expect(partyReads()).toBe(1);
  });

  it("rebuilds warm state after a turn that ran a tool", async () => {
    const { foundry, partyReads } = countingFoundry();
    const provider = new FakeLLMProvider([
      {
        match: (r) => r.messages.length === 1,
        events: [
          { kind: "tool_call", id: "tu_1", name: "noticer", input: { note: "x" } },
          { kind: "done", stopReason: "tool_use", usage: DONE_USAGE },
        ],
      },
      {
        match: (r) => r.messages.length === 3,
        events: [
          { kind: "text_delta", text: "Done." },
          { kind: "done", stopReason: "end_turn", usage: DONE_USAGE },
        ],
      },
    ]);
    const { session } = setupSession({ foundry, llm: provider });
    registerToolThatRecordsName(session, "noticer", {});
    await runTurn(session, { speaker: "p", text: "I act." });
    expect(partyReads()).toBe(2);
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

describe("session lifecycle + dialogue persistence (Phase 2c)", () => {
  it("startSession creates a session row", () => {
    const { session, tenantDb } = setupSession();
    const row = tenantDb.sessions.get(session.config.sessionId);
    expect(row).toBeDefined();
    expect(row?.campaignId).toBe("c1");
    expect(row?.behaviorSpecVersion).toBe("v0.1");
    expect(row?.endedAt).toBeNull();
  });

  it("runTurn persists player and narrator dialogue rows", async () => {
    const { session, tenantDb } = setupSession({
      llm: fakeLlmFromEvents([
        { kind: "text_delta", text: "A reply." },
        { kind: "done", stopReason: "end_turn", usage: DONE_USAGE },
      ]),
    });
    await runTurn(session, { speaker: "player1", displayName: "Aragorn", text: "Hi there." });
    const rows = tenantDb.dialogue.listBySession("sess-1");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.speaker).toBe("player1");
    expect(rows[0]?.displayName).toBe("Aragorn");
    expect(rows[0]?.text).toBe("Hi there.");
    expect(rows[1]?.speaker).toBe("narrator");
    expect(rows[1]?.text).toBe("A reply.");
  });

  it("increments turnCount per turn", async () => {
    const { session } = setupSession();
    expect(session.turnCount).toBe(0);
    await runTurn(session, { speaker: "p", text: "one" });
    await runTurn(session, { speaker: "p", text: "two" });
    expect(session.turnCount).toBe(2);
  });

  it("startSession resumes prior dialogue (hydrates from DB)", async () => {
    const { session } = setupSession();
    await runTurn(session, { speaker: "p", text: "first turn" });
    // A new Session over the same sessionId hydrates the persisted dialogue.
    const resumed = startSession(session.config);
    const texts = resumed.dialogue.map((d) => d.text);
    expect(texts).toContain("first turn");
    expect(texts).toContain("Default narration.");
  });

  it("endSession stamps endedAt and stores a summary", () => {
    const { session, tenantDb } = setupSession();
    endSession(session, JSON.stringify({ beats: ["intro"] }));
    const row = tenantDb.sessions.get("sess-1");
    expect(row?.endedAt).toBeGreaterThan(0);
    expect(row?.summaryJson).toContain("intro");
  });
});

describe("runTurn + archiveSession — cold/episodic memory (design doc 0019)", () => {
  it("injects retrieved memory into the hot context", async () => {
    const embed = new FakeEmbeddingProvider();
    const store = new InMemoryMemoryStore();
    const [vec] = await embed.embed(["the party spared the goblin Yeemik"]);
    await store.upsert([
      {
        id: "m1",
        kind: "episodic",
        text: "the party spared the goblin Yeemik",
        vector: vec!,
        metadata: { campaignId: "c1", createdAt: 1, embedModel: embed.name },
      },
    ]);
    const llm = fakeLlmFromEvents([
      { kind: "text_delta", text: "ok" },
      { kind: "done", stopReason: "end_turn", usage: DONE_USAGE },
    ]);
    const { session } = setupSession({ llm, memory: { embed, store } });
    await runTurn(session, { speaker: "discord:1", text: "what about that goblin we spared?" });
    const req = (llm as FakeLLMProvider).receivedRequests[0]!;
    const userText = req.messages[0]!.content.map((c) => (c.type === "text" ? c.text : "")).join(
      "",
    );
    expect(userText).toContain("Relevant memory");
    expect(userText).toContain("Yeemik");
  });

  it("archiveSession summarizes the session and stores an episodic record", async () => {
    const embed = new FakeEmbeddingProvider();
    const store = new InMemoryMemoryStore();
    const llm = new FakeLLMProvider([
      {
        match: (r) => r.modelTier === "narration",
        events: [
          { kind: "text_delta", text: "You enter the ruins." },
          { kind: "done", stopReason: "end_turn", usage: DONE_USAGE },
        ],
      },
      {
        match: (r) => r.modelTier === "orchestration",
        events: [
          {
            kind: "text_delta",
            text: '{"summary": "The party explored the ancient ruins.", "deltas": {"location": "ruins"}}',
          },
          { kind: "done", stopReason: "end_turn", usage: DONE_USAGE },
        ],
      },
    ]);
    const { session } = setupSession({ llm, memory: { embed, store } });
    await runTurn(session, { speaker: "discord:1", text: "I look around" });
    const record = await archiveSession(session);
    expect(record).not.toBeNull();
    expect(record!.kind).toBe("episodic");
    expect(record!.metadata.deltas).toEqual({ location: "ruins" });
    const [q] = await embed.embed(["ruins"]);
    const out = await store.query(q!, { campaignId: "c1", topK: 5 });
    expect(out.some((r) => r.text.includes("ruins"))).toBe(true);
  });

  it("archiveSession is a no-op without memory configured", async () => {
    const { session } = setupSession();
    await runTurn(session, { speaker: "discord:1", text: "hi" });
    expect(await archiveSession(session)).toBeNull();
  });
});

describe("runTurn — side-channel scoping (design doc 0026)", () => {
  function hotContextText(llm: FakeLLMProvider, i = 0): string {
    const block = llm.receivedRequests[i]!.messages[0]!.content[0] as { text?: string };
    return block.text ?? "";
  }

  it("persists a private audience + conversationId and uses the requested model tier", async () => {
    const llm = fakeLlmFromEvents([
      { kind: "text_delta", text: "Psst — the chest is trapped." },
      { kind: "done", stopReason: "end_turn", usage: DONE_USAGE },
    ]);
    const { session, tenantDb } = setupSession({ llm });

    const out = await runTurn(
      session,
      { speaker: "discord:dana", text: "Quietly: is the chest trapped?" },
      {
        conversation: { id: "player:discord:dana", audience: "player:discord:dana" },
        modelTier: "orchestration",
      },
    );

    expect(out.narration).toBe("Psst — the chest is trapped.");
    expect(llm.receivedRequests[0]!.modelTier).toBe("orchestration");

    // The player's question and the DM's reply are both stored privately.
    const danaThread = tenantDb.dialogue.listByConversation("sess-1", "player:discord:dana");
    expect(danaThread.map((r) => r.speaker)).toEqual(["discord:dana", "narrator"]);
    expect(danaThread.map((r) => r.audience)).toEqual([
      "player:discord:dana",
      "player:discord:dana",
    ]);
    // Nothing leaked into the shared table conversation.
    expect(tenantDb.dialogue.listByConversation("sess-1", "table")).toHaveLength(0);
  });

  it("a side-channel's context excludes gm secrets and other players' private content (§10)", async () => {
    const llm = fakeLlmFromEvents([
      { kind: "text_delta", text: "ok" },
      { kind: "done", stopReason: "end_turn", usage: DONE_USAGE },
    ]);
    const { session } = setupSession({ llm });
    session.dialogue.push(
      {
        speaker: "narrator",
        text: "SHARED tavern scene",
        timestamp: 1,
        audience: "table",
        conversationId: "table",
      },
      {
        speaker: "gm",
        text: "GMSECRET the chest DC is 18",
        timestamp: 2,
        audience: "gm",
        conversationId: "table",
      },
      {
        speaker: "discord:eli",
        text: "ELIPRIVATE plan to steal",
        timestamp: 3,
        audience: "player:discord:eli",
        conversationId: "player:discord:eli",
      },
    );

    await runTurn(
      session,
      { speaker: "discord:dana", text: "what do I see?" },
      {
        conversation: { id: "player:discord:dana", audience: "player:discord:dana" },
        modelTier: "orchestration",
      },
    );

    const prompt = hotContextText(llm);
    expect(prompt).toContain("SHARED tavern scene"); // shared world is visible
    expect(prompt).toContain("what do I see?"); // the player's own input is visible
    expect(prompt).not.toContain("GMSECRET"); // gm secrets are not
    expect(prompt).not.toContain("ELIPRIVATE"); // another player's private content is not
  });

  it("the table loop sees gm secrets but never a player's private content", async () => {
    const llm = fakeLlmFromEvents([
      { kind: "text_delta", text: "ok" },
      { kind: "done", stopReason: "end_turn", usage: DONE_USAGE },
    ]);
    const { session } = setupSession({ llm });
    session.dialogue.push(
      {
        speaker: "gm",
        text: "GMSECRET DC 18",
        timestamp: 1,
        audience: "gm",
        conversationId: "table",
      },
      {
        speaker: "discord:eli",
        text: "ELIPRIVATE plan",
        timestamp: 2,
        audience: "player:discord:eli",
        conversationId: "player:discord:eli",
      },
    );

    await runTurn(session, { speaker: "discord:dana", text: "I open the door." });

    const prompt = hotContextText(llm);
    expect(prompt).toContain("GMSECRET DC 18"); // the DM brain sees gm secrets at the table
    expect(prompt).not.toContain("ELIPRIVATE"); // but never a player's private side-channel
  });
});
