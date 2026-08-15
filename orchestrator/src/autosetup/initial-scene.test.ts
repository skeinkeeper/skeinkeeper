// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { describe, expect, it } from "vitest";
import { MockFoundryClient } from "../foundry/mock.js";
import type { FoundryScene } from "../foundry/client.js";
import type { ExtendedIntakeResult, SceneSummary } from "../intake/types.js";
import { activateScene, chooseInitialScene } from "./initial-scene.js";

const starter: SceneSummary = {
  id: "s-start",
  name: "Goblin Ambush",
  active: true,
  isStarter: true,
};
const intro: SceneSummary = {
  id: "s-intro",
  name: "Session Start — Stonehill",
  active: false,
  isStarter: true,
};
const cave: SceneSummary = {
  id: "s-cave",
  name: "Wave Echo Cave",
  active: false,
  isStarter: false,
};

function intake(scenes: SceneSummary[]): ExtendedIntakeResult {
  return {
    loadedModules: [],
    compendiumPacks: [],
    existingScenes: scenes,
    currentOwnershipMap: {},
    warmStateSummary: {
      priorSessionCount: 0,
      questFlagCount: 0,
      consentedPlayerCount: 0,
      mappedPlayerCount: 0,
    },
    findings: [],
  };
}

describe("chooseInitialScene", () => {
  it("already-active when the current scene matches a starter convention", () => {
    const choice = chooseInitialScene(intake([starter, cave]), {
      intake: { resolvedFindings: {} },
    });
    expect(choice).toEqual({
      kind: "unambiguous",
      sceneId: "s-start",
      reason: "already-active",
    });
  });

  it("single-starter when exactly one starter exists and nothing else is active", () => {
    const unused = { ...starter, active: false };
    const choice = chooseInitialScene(intake([unused, cave]), { intake: { resolvedFindings: {} } });
    expect(choice).toEqual({
      kind: "unambiguous",
      sceneId: "s-start",
      reason: "single-starter",
    });
  });

  it("prior-resolved when SessionConfig names a scene that still exists", () => {
    const choice = chooseInitialScene(intake([starter, intro, cave]), {
      intake: { resolvedFindings: {}, chosenStartingSceneId: "s-intro" },
    });
    expect(choice).toEqual({
      kind: "unambiguous",
      sceneId: "s-intro",
      reason: "prior-resolved",
    });
  });

  it("ambiguous when two starters are equally plausible", () => {
    const choice = chooseInitialScene(intake([{ ...starter, active: false }, intro]), {
      intake: { resolvedFindings: {} },
    });
    expect(choice.kind).toBe("ambiguous");
    if (choice.kind === "ambiguous") {
      expect(choice.candidates.map((c) => c.id).sort()).toEqual(["s-intro", "s-start"]);
    }
  });

  it("none when no scene matches a starter convention", () => {
    const choice = chooseInitialScene(intake([cave]), { intake: { resolvedFindings: {} } });
    expect(choice).toEqual({ kind: "none" });
  });
});

describe("activateScene", () => {
  const startScene: FoundryScene = {
    id: "s-start",
    name: "Goblin Ambush",
    active: true,
    tokens: [],
  };
  const caveScene: FoundryScene = {
    id: "s-cave",
    name: "Wave Echo Cave",
    active: false,
    tokens: [],
  };

  it("does not call setActiveScene when the scene is already active", async () => {
    const foundry = new MockFoundryClient({
      system: "dnd5e",
      scenes: [startScene, caveScene],
      activeSceneId: "s-start",
    });
    await activateScene(foundry, "s-start");
    expect(foundry.sceneSwitches).toEqual([]);
  });

  it("switches only on mismatch", async () => {
    const foundry = new MockFoundryClient({
      system: "dnd5e",
      scenes: [startScene, caveScene],
      activeSceneId: "s-cave",
    });
    await activateScene(foundry, "s-start");
    expect(foundry.sceneSwitches).toEqual(["s-start"]);
    expect((await foundry.getActiveScene())?.id).toBe("s-start");
  });
});
