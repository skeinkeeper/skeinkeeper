// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { describe, expect, it } from "vitest";
import { openDb, TenantDb, schema } from "@skeinkeeper/server";
import type { BehaviorSpec } from "../behavior.js";
import { MockFoundryClient } from "../foundry/mock.js";
import { FakeLLMProvider, fakeLlmFromEvents } from "../interfaces/fake_llm_provider.js";
import { ToolDispatcher } from "../registry.js";
import { runTurn, startSession } from "../session.js";
import { FakeOutboundSurface, SurfaceRouter } from "../surfaces/index.js";
import { createDefaultRegistry } from "../tools/index.js";

const SPEC: BehaviorSpec = {
  content: "You are the AI DM.",
  version: "v0.1",
  path: "/test/spec.md",
};

const DONE_USAGE = { inputTokens: 10, outputTokens: 8 };

function setup(llm: FakeLLMProvider) {
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
  const player = new FakeOutboundSurface("foundry-whisper", ["player"]);
  const table = new FakeOutboundSurface("foundry-public", ["table"]);
  const voice = new FakeOutboundSurface("discord-voice", ["table"], { unboundedEmit: true });
  const router = new SurfaceRouter();
  router.register(player);
  router.register(table);
  router.register(voice);
  const session = startSession({
    sessionId: "sess-1",
    campaignId: "c1",
    behaviorSpec: SPEC,
    llm,
    dispatcher: new ToolDispatcher({ registry: createDefaultRegistry() }),
    foundry: new MockFoundryClient({ system: "dnd5e" }),
    tenantDb,
    surfaces: router,
  });
  return { session, player, table, voice };
}

describe("side-channel outbound emit (TDD 0035)", () => {
  it("emits player-audience narration for a side-channel Q&A turn", async () => {
    const { session, player, table } = setup(
      fakeLlmFromEvents([
        { kind: "text_delta", text: "The lock looks pickable." },
        { kind: "done", stopReason: "end_turn", usage: DONE_USAGE },
      ]),
    );
    await runTurn(
      session,
      { speaker: "discord-p1", text: "Can I pick it quietly?" },
      { conversation: { id: "player:p1", audience: "player:p1" } },
    );
    expect(table.emits).toHaveLength(0);
    expect(player.emits).toEqual([
      {
        audience: { kind: "player", playerId: "discord-p1" },
        text: "The lock looks pickable.",
      },
    ]);
  });

  it("flips to table after resolve_action (private initiation, public resolution)", async () => {
    const llm = new FakeLLMProvider([
      {
        match: (r) => r.messages.length === 1,
        events: [
          { kind: "text_delta", text: "Wait for the opening." },
          {
            kind: "tool_call",
            id: "tu_w",
            name: "whisper",
            input: { playerId: "discord-p1", text: "Wait for the opening." },
          },
          { kind: "done", stopReason: "tool_use", usage: DONE_USAGE },
        ],
      },
      {
        events: [
          {
            kind: "tool_call",
            id: "tu_r",
            name: "resolve_action",
            input: {
              narration: "Mid-sentence, Dana's blade buries itself in the cultist's throat.",
            },
          },
          { kind: "done", stopReason: "end_turn", usage: DONE_USAGE },
        ],
      },
    ]);
    const { session, player, table, voice } = setup(llm);
    await runTurn(
      session,
      { speaker: "discord-p1", text: "I draw and stab the cultist." },
      { conversation: { id: "player:p1", audience: "player:p1" } },
    );

    expect(player.emits[0]).toEqual({
      audience: { kind: "player", playerId: "discord-p1" },
      text: "Wait for the opening.",
    });
    const tableTexts = table.emits.map((e) => e.text);
    expect(tableTexts).toContain(
      "Mid-sentence, Dana's blade buries itself in the cultist's throat.",
    );
    expect(table.emits[0]?.audience).toEqual({ kind: "table" });
    expect(voice.emits.map((e) => e.text)).toContain(
      "Mid-sentence, Dana's blade buries itself in the cultist's throat.",
    );
  });
});
