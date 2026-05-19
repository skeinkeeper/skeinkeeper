// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { describe, expect, it } from "vitest";
import { fakeLlmFromEvents } from "@skeinkeeper/orchestrator";
import type { Fixture } from "./fixture.js";
import { fakeLlmFromScript } from "./llm_script.js";
import { OrchestratorRunner } from "./orchestrator_runner.js";

function fixture(overrides: Partial<Fixture> = {}): Fixture {
  return {
    path: "test-fixture.eval.yaml",
    name: "test",
    scenario: {
      turns: [{ speaker: "player", text: "I look around the tavern." }],
    },
    expectations: [],
    ...overrides,
  };
}

describe("OrchestratorRunner", () => {
  it("accumulates text_delta events into narration", async () => {
    const provider = fakeLlmFromEvents([
      { kind: "text_delta", text: "The tavern is " },
      { kind: "text_delta", text: "dimly lit." },
      { kind: "done", stopReason: "end_turn", usage: { inputTokens: 50, outputTokens: 12 } },
    ]);
    const runner = new OrchestratorRunner(provider);
    const out = await runner.run({ fixture: fixture() });
    expect(out.narration).toBe("The tavern is dimly lit.");
    expect(out.toolCalls).toEqual([]);
  });

  it("captures tool_call events in order", async () => {
    const provider = fakeLlmFromScript({
      narration: "Roll initiative.",
      toolCalls: [
        { name: "roll", input: { formula: "1d20+2" } },
        { name: "set_quest_flag", input: { campaignId: "c1", key: "combat.started", value: "true" } },
      ],
    });
    const runner = new OrchestratorRunner(provider);
    const out = await runner.run({ fixture: fixture() });
    expect(out.toolCalls).toHaveLength(2);
    expect(out.toolCalls?.[0]?.name).toBe("roll");
    expect(out.toolCalls?.[1]?.name).toBe("set_quest_flag");
  });

  it("stops gracefully on error, returning narration accumulated so far", async () => {
    const provider = fakeLlmFromEvents([
      { kind: "text_delta", text: "Partial..." },
      { kind: "error", error: { kind: "overloaded", message: "529" } },
    ]);
    const runner = new OrchestratorRunner(provider);
    const out = await runner.run({ fixture: fixture() });
    expect(out.narration).toBe("Partial...");
  });

  it("collapses multiple scenario turns into a single user message (Phase 1.5c shape)", async () => {
    const provider = fakeLlmFromScript({ narration: "ok" });
    const runner = new OrchestratorRunner(provider);
    const out = await runner.run({
      fixture: fixture({
        scenario: {
          turns: [
            { speaker: "player", text: "I draw my sword." },
            { speaker: "operator", text: "(GM aside: the goblin is wary.)" },
            { speaker: "player", text: "I step forward." },
          ],
        },
      }),
    });
    expect(out.narration).toBe("ok");
    // Verify all three turns landed in the captured user message.
    const msg = provider.receivedRequests[0]?.messages[0];
    expect(msg?.role).toBe("user");
    const text = msg?.content[0]?.type === "text" ? msg.content[0].text : "";
    expect(text).toContain("I draw my sword.");
    expect(text).toContain("(GM aside: the goblin is wary.)");
    expect(text).toContain("I step forward.");
  });
});

describe("OrchestratorRunner — behavior spec (Phase 1.6)", () => {
  it("uses the placeholder when no behavior_spec is set", async () => {
    const provider = fakeLlmFromScript({ narration: "ok" });
    const runner = new OrchestratorRunner(provider);
    await runner.run({ fixture: fixture() });
    expect(provider.receivedRequests[0]?.systemPrompt).toContain("placeholder");
  });

  it("uses the inline string when behavior_spec is { inline }", async () => {
    const provider = fakeLlmFromScript({ narration: "ok" });
    const runner = new OrchestratorRunner(provider);
    await runner.run({
      fixture: fixture({
        behaviorSpec: { inline: "You are a terse DM. Reply with one sentence." },
      }),
    });
    expect(provider.receivedRequests[0]?.systemPrompt).toBe(
      "You are a terse DM. Reply with one sentence.",
    );
  });

  it("loads behavior/default.md when behavior_spec is 'default'", async () => {
    const provider = fakeLlmFromScript({ narration: "ok" });
    const runner = new OrchestratorRunner(provider);
    await runner.run({
      fixture: fixture({
        behaviorSpec: "default",
        behaviorSpecVersion: "v0.1",
      }),
    });
    const sp = provider.receivedRequests[0]?.systemPrompt ?? "";
    expect(sp.length).toBeGreaterThan(1000);
    expect(sp).toContain("Skeinkeeper");
    expect(sp).toContain("v0.1");
  });

  it("throws BehaviorSpecError on version mismatch when 'default' is loaded", async () => {
    const provider = fakeLlmFromScript({ narration: "ok" });
    const runner = new OrchestratorRunner(provider);
    await expect(
      runner.run({
        fixture: fixture({
          behaviorSpec: "default",
          behaviorSpecVersion: "v9.9",
        }),
      }),
    ).rejects.toThrow(/Spec version mismatch/);
  });
});
