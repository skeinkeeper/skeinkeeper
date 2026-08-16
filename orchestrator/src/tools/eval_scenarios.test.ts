// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

/**
 * Eval-implication fixtures from TDD 0033. Deterministic MockFoundryClient
 * + ToolDispatcher — no LLM. Detailed cases live in triggered.test.ts and
 * perception/event-stream.test.ts; this file names the TDD scenarios.
 */

import { describe, expect, it } from "vitest";
import { createDefaultRegistry } from "./index.js";
import {
  MockFoundryEventStream,
  NullFoundryEventStream,
  takePerceptionEvents,
} from "../perception/event-stream.js";

describe("TDD 0033 eval scenarios (named)", () => {
  it("registers the triggered-action tools", () => {
    const names = createDefaultRegistry()
      .list()
      .map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "reveal_token",
        "hide_token",
        "place_hidden_token",
        "share_journal_to_audience",
        "distribute_loot",
      ]),
    );
  });

  it("9. null stream subscribe is a no-op; first consume notices once", () => {
    const stream = new NullFoundryEventStream();
    const unsub = stream.subscribe(() => {
      throw new Error("null stream must not emit");
    });
    unsub();
    const notices: string[] = [];
    const state = { kind: "null" as const, noticed: false, events: [] };
    takePerceptionEvents(state, (m) => notices.push(m));
    takePerceptionEvents(state, (m) => notices.push(m));
    expect(notices).toEqual(["perception not yet available"]);
  });

  it("10. MockFoundryEventStream delivers a scripted sequence in order", () => {
    const stream = new MockFoundryEventStream();
    const received: string[] = [];
    stream.subscribe((e) => received.push(e.type));
    stream.emit({ type: "combat-started", combatId: "c", sceneId: "s" });
    stream.emit({ type: "combat-ended", combatId: "c" });
    expect(received).toEqual(["combat-started", "combat-ended"]);
  });
});
