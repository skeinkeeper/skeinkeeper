// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { describe, expect, it } from "vitest";
import { MockFoundryClient } from "../foundry/mock.js";
import type { FoundryScene } from "../foundry/client.js";
import { applyIntakeResolution, createIntakeResolutionState } from "./resolve.js";
import type { IntakeFinding } from "./types.js";

const start: FoundryScene = { id: "s-start", name: "Session Start", active: false, tokens: [] };
const cave: FoundryScene = { id: "s-cave", name: "Wave Echo Cave", active: false, tokens: [] };

const sceneFinding: IntakeFinding = {
  id: 10,
  code: "AMBIG_STARTING_SCENE",
  kind: "ambiguity",
  summary: "Pick a starting scene",
  dmOnly: true,
  resolution: {
    prompt: "Which scene?",
    options: [
      { id: "s-start", label: "Session Start" },
      { id: "s-cave", label: "Wave Echo Cave" },
    ],
    applyOnResolve: "scene-choice",
  },
};

const moduleFinding: IntakeFinding = {
  id: 11,
  code: "MULTIPLE_CAMPAIGN_MODULES",
  kind: "ambiguity",
  summary: "Pick a module",
  dmOnly: false,
  resolution: {
    prompt: "Which module?",
    options: [
      { id: "lmop", label: "LMoP" },
      { id: "ravenloft", label: "Ravenloft" },
    ],
    applyOnResolve: "module-choice",
  },
};

describe("applyIntakeResolution", () => {
  it("writes scene-choice onto SessionConfig.intake and activates the scene", async () => {
    const foundry = new MockFoundryClient({ system: "dnd5e", scenes: [start, cave] });
    const state = createIntakeResolutionState([sceneFinding]);
    const result = await applyIntakeResolution(state, 10, "s-start", { foundry });
    expect(result.status).toBe("resolved");
    expect(state.intake.chosenStartingSceneId).toBe("s-start");
    expect(state.intake.resolvedFindings.AMBIG_STARTING_SCENE).toBe("s-start");
    expect((await foundry.getActiveScene())?.id).toBe("s-start");
  });

  it("writes module-choice onto SessionConfig.intake", async () => {
    const state = createIntakeResolutionState([moduleFinding]);
    const result = await applyIntakeResolution(state, 11, "lmop");
    expect(result.status).toBe("resolved");
    expect(state.intake.chosenCampaignModuleId).toBe("lmop");
  });

  it("is idempotent for already-resolved or unknown findings", async () => {
    const state = createIntakeResolutionState([moduleFinding]);
    await applyIntakeResolution(state, 11, "lmop");
    expect((await applyIntakeResolution(state, 11, "ravenloft")).status).toBe("already-resolved");
    expect(state.intake.chosenCampaignModuleId).toBe("lmop");
    expect((await applyIntakeResolution(state, 99, "x")).status).toBe("no-longer-applicable");
  });

  it("rejects an option that is no longer on the finding", async () => {
    const state = createIntakeResolutionState([moduleFinding]);
    const result = await applyIntakeResolution(state, 11, "not-a-module");
    expect(result.status).toBe("no-longer-applicable");
    expect(state.intake.chosenCampaignModuleId).toBeUndefined();
  });
});
