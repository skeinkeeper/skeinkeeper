// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { afterEach, describe, expect, it } from "vitest";
import { FakeEmbeddingProvider } from "../interfaces/embedding.js";
import { InMemoryMemoryStore } from "../memory/store.js";
import { MockFoundryClient } from "../foundry/mock.js";
import type { FoundryActor, FoundryScene } from "../foundry/client.js";
import { resetIndexRefreshMutexForTests } from "./index-refresh.js";
import { createSessionRunState } from "../session/run-state.js";
import { dispatchPostIntakeAutosetup } from "./dispatch.js";
import type { ExtendedIntakeResult } from "../intake/types.js";
import type { WorldContentReader } from "./world-types.js";

afterEach(() => {
  resetIndexRefreshMutexForTests();
});

const hero: FoundryActor = {
  id: "a1",
  name: "Hero",
  type: "character",
  system: "dnd5e",
  sheet: { details: { race: "Human", class: "Fighter" } },
};
const start: FoundryScene = { id: "s-start", name: "Session Start", active: true, tokens: [] };

const intake: ExtendedIntakeResult = {
  loadedModules: [],
  compendiumPacks: [],
  existingScenes: [{ id: "s-start", name: "Session Start", active: true, isStarter: true }],
  currentOwnershipMap: {},
  warmStateSummary: {
    priorSessionCount: 0,
    questFlagCount: 0,
    consentedPlayerCount: 0,
    mappedPlayerCount: 0,
  },
  findings: [],
};

describe("dispatchPostIntakeAutosetup", () => {
  it("returns scene actions without waiting for indexing", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const world: WorldContentReader = {
      readJournals: async () => {
        await held;
        return [{ id: "j1", name: "Phandalin", text: "town" }];
      },
      readScenes: async () => [],
      readCreatures: async () => [],
      readActorItems: async () => [],
    };
    const runState = createSessionRunState();
    expect(runState.coldIndexReady).toBe(false);
    const foundry = new MockFoundryClient({
      system: "dnd5e",
      actors: [hero],
      partyActorIds: ["a1"],
      scenes: [start],
      activeSceneId: "s-start",
    });
    const result = await dispatchPostIntakeAutosetup({
      intake,
      sessionConfig: { intake: { resolvedFindings: {} } },
      foundry,
      memory: new InMemoryMemoryStore(),
      embed: new FakeEmbeddingProvider(),
      worldContent: world,
      runState,
      campaignId: "c1",
      sessionId: "sess-1",
    });
    expect(result.actions.some((a) => a.includes("Activated"))).toBe(true);
    expect(runState.coldIndexReady).toBe(false);
    expect(result.index).toBeDefined();
    release();
    await result.index;
    expect(runState.coldIndexReady).toBe(true);
  });

  it("invokes the TDD 0036 identity-preflight hook when provided", async () => {
    const calls: string[] = [];
    const foundry = new MockFoundryClient({
      system: "dnd5e",
      actors: [hero],
      partyActorIds: ["a1"],
      scenes: [start],
      activeSceneId: "s-start",
    });
    await dispatchPostIntakeAutosetup({
      intake,
      sessionConfig: { intake: { resolvedFindings: {} } },
      foundry,
      campaignId: "c1",
      sessionId: "sess-1",
      verifyIdentityPreflight: async (args) => {
        calls.push(args.campaignId);
      },
    });
    expect(calls).toEqual(["c1"]);
  });
});
