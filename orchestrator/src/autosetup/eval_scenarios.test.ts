// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

/**
 * Eval-implication fixtures from TDD 0032. Deterministic MockFoundryClient
 * + InMemoryMemoryStore — classifiers and index are rubrics, not LLM judgment.
 */

import { afterEach, describe, expect, it } from "vitest";
import { FakeEmbeddingProvider } from "../interfaces/embedding.js";
import { InMemoryMemoryStore } from "../memory/store.js";
import { MockFoundryClient } from "../foundry/mock.js";
import type { FoundryActor, FoundryScene } from "../foundry/client.js";
import { formatIntakeReportForOperator } from "../intake/report.js";
import { applyIntakeResolution, createIntakeResolutionState } from "../intake/resolve.js";
import { chooseInitialScene } from "./initial-scene.js";
import { refreshIndex, resetIndexRefreshMutexForTests } from "./index-refresh.js";
import { preloadExpectedContent } from "./preload.js";
import { dispatchPostIntakeAutosetup } from "./dispatch.js";
import { createSessionRunState } from "../session/run-state.js";
import type { ExtendedIntakeResult } from "../intake/types.js";
import type { WorldContentReader, WorldJournalEntry } from "./world-types.js";

afterEach(() => {
  resetIndexRefreshMutexForTests();
});

const hero: FoundryActor = {
  id: "a1",
  name: "Hero",
  type: "character",
  system: "dnd5e",
  sheet: { details: { race: "Goblin", class: "Fighter" } },
};
const start: FoundryScene = { id: "s-start", name: "Goblin Ambush", active: true, tokens: [] };
const intro: FoundryScene = { id: "s-intro", name: "Session Start", active: false, tokens: [] };

function intakeOf(foundry: MockFoundryClient): Promise<ExtendedIntakeResult> {
  return foundry.listScenes().then((scenes) => ({
    loadedModules: [],
    compendiumPacks: [],
    existingScenes: scenes.map((s) => ({
      id: s.id,
      name: s.name,
      active: s.active,
      isStarter: /start|intro|ambush/i.test(s.name),
    })),
    currentOwnershipMap: {},
    warmStateSummary: {
      priorSessionCount: 0,
      questFlagCount: 0,
      consentedPlayerCount: 0,
      mappedPlayerCount: 0,
    },
    findings: [],
  }));
}

function journals(entries: WorldJournalEntry[]): WorldContentReader {
  return {
    readJournals: async () => entries,
    readScenes: async () => [],
    readCreatures: async () => [],
    readActorItems: async () => [],
  };
}

describe("TDD 0032 eval scenarios", () => {
  it("1. unambiguous already-active — no switch-scene; footer reports the choice", async () => {
    const foundry = new MockFoundryClient({
      system: "dnd5e",
      actors: [hero],
      partyActorIds: ["a1"],
      scenes: [start],
      activeSceneId: "s-start",
    });
    const intake = await intakeOf(foundry);
    const choice = chooseInitialScene(intake, { intake: { resolvedFindings: {} } });
    expect(choice).toEqual({ kind: "unambiguous", sceneId: "s-start", reason: "already-active" });
    const dispatched = await dispatchPostIntakeAutosetup({
      intake,
      sessionConfig: { intake: { resolvedFindings: {} } },
      foundry,
      campaignId: "c1",
      sessionId: "sess-1",
    });
    expect(foundry.sceneSwitches).toEqual([]);
    const payload = formatIntakeReportForOperator(dispatched.findings, {
      actions: dispatched.actions,
    });
    expect(payload.text).toContain("I did the following");
    expect(payload.text).toContain("Goblin Ambush");
  });

  it("2. ambiguous starters resolve to prior-resolved on the next Start", async () => {
    const foundry = new MockFoundryClient({
      system: "dnd5e",
      actors: [hero],
      partyActorIds: ["a1"],
      scenes: [{ ...start, active: false }, intro],
    });
    const intake = await intakeOf(foundry);
    const choice = chooseInitialScene(intake, { intake: { resolvedFindings: {} } });
    expect(choice.kind).toBe("ambiguous");
    const dispatched = await dispatchPostIntakeAutosetup({
      intake,
      sessionConfig: { intake: { resolvedFindings: {} } },
      foundry,
      campaignId: "c1",
      sessionId: "sess-1",
    });
    const finding = dispatched.findings.find((f) => f.code === "AMBIG_STARTING_SCENE")!;
    finding.id = 7;
    const state = createIntakeResolutionState([finding]);
    await applyIntakeResolution(state, 7, "s-intro");
    expect(state.intake.chosenStartingSceneId).toBe("s-intro");
    const next = chooseInitialScene(intake, { intake: state.intake });
    expect(next).toEqual({ kind: "unambiguous", sceneId: "s-intro", reason: "prior-resolved" });
  });

  it("4. incremental indexing reports add/update/delete", async () => {
    const store = new InMemoryMemoryStore();
    const embed = new FakeEmbeddingProvider();
    await refreshIndex(
      journals([
        { id: "j-keep", name: "Keep", text: "same", modifiedAt: "2026-01-01" },
        { id: "j-old", name: "Old", text: "v1", modifiedAt: "2026-01-01" },
        { id: "j-gone", name: "Gone", text: "bye", modifiedAt: "2026-01-01" },
      ]),
      store,
      embed,
      { campaignId: "c1" },
    );
    const second = await refreshIndex(
      journals([
        { id: "j-keep", name: "Keep", text: "same", modifiedAt: "2026-01-01" },
        { id: "j-old", name: "Old", text: "v2", modifiedAt: "2026-02-01" },
        { id: "j-new-a", name: "A", text: "a", modifiedAt: "2026-02-01" },
        { id: "j-new-b", name: "B", text: "b", modifiedAt: "2026-02-01" },
      ]),
      store,
      embed,
      { campaignId: "c1" },
    );
    expect(second.perSource["world-journal"]).toEqual({ added: 2, updated: 1, deleted: 1 });
  });

  it("5. per-source isolation still flips coldIndexReady", async () => {
    const runState = createSessionRunState();
    const world: WorldContentReader = {
      readJournals: async () => [{ id: "j1", name: "Phandalin", text: "town" }],
      readScenes: async () => [{ id: "s1", name: "Start", active: false }],
      readCreatures: async () => {
        throw new Error("creature parse");
      },
      readActorItems: async () => [],
    };
    const foundry = new MockFoundryClient({
      system: "dnd5e",
      actors: [hero],
      partyActorIds: ["a1"],
      scenes: [start],
      activeSceneId: "s-start",
    });
    const result = await dispatchPostIntakeAutosetup({
      intake: await intakeOf(foundry),
      sessionConfig: { intake: { resolvedFindings: {} } },
      foundry,
      memory: new InMemoryMemoryStore(),
      embed: new FakeEmbeddingProvider(),
      worldContent: world,
      runState,
      campaignId: "c1",
      sessionId: "sess-1",
    });
    const report = await result.index;
    expect(report?.errors.some((e) => e.source === "world-creature")).toBe(true);
    expect(runState.coldIndexReady).toBe(true);
  });

  it("6. preload second run creates zero actors", async () => {
    const foundry = new MockFoundryClient({
      system: "dnd5e",
      actors: [hero],
      partyActorIds: ["a1"],
      scenes: [start],
      activeSceneId: "s-start",
      compendiumHits: [{ id: "goblin", name: "Goblin", packId: "dnd5e.monsters", type: "npc" }],
    });
    const intake = await intakeOf(foundry);
    const first = await preloadExpectedContent(foundry, intake, { campaignId: "c1" });
    const second = await preloadExpectedContent(foundry, intake, { campaignId: "c1" });
    expect(first.created).toBeGreaterThan(0);
    expect(second.created).toBe(0);
  });

  it("7. byMetadata({ location: Phandalin }) ranks only that location", async () => {
    const store = new InMemoryMemoryStore();
    await store.upsert([
      {
        id: "near",
        kind: "cold",
        text: "Phandalin town square",
        vector: [1, 0],
        metadata: {
          campaignId: "c1",
          createdAt: 1,
          embedModel: "fake",
          source: "world-journal",
          location: "Phandalin",
        },
      },
      {
        id: "far",
        kind: "cold",
        text: "Wave Echo Cave",
        vector: [0.9, 0.1],
        metadata: {
          campaignId: "c1",
          createdAt: 1,
          embedModel: "fake",
          source: "world-scene",
          location: "Wave Echo Cave",
        },
      },
    ]);
    const filtered = await store.byMetadata({ campaignId: "c1", location: "Phandalin" });
    expect(filtered.map((r) => r.id)).toEqual(["near"]);
    const ranked = await store.query([1, 0], {
      campaignId: "c1",
      topK: 5,
      metadata: { location: "Phandalin" },
    });
    expect(ranked.map((r) => r.id)).toEqual(["near"]);
  });
});
