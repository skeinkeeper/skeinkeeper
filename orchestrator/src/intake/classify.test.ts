// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { describe, expect, it } from "vitest";
import { classifyAmbiguities, classifyCriticalGaps, classifyRecommendations } from "./classify.js";
import type {
  ActorSummary,
  IntakeContext,
  ModuleSummary,
  PackSummary,
  SceneSummary,
  SessionIntakeConfig,
} from "./types.js";

const ctx = (intake: SessionIntakeConfig = { resolvedFindings: {} }): IntakeContext => ({
  campaignId: "c1",
  sessionId: "sess-1",
  sessionConfig: { intake },
});

const party: ActorSummary[] = [
  { id: "a1", name: "Fighter", type: "character", race: "Human", class: "Fighter" },
];
const starter: SceneSummary = {
  id: "s-start",
  name: "Session Start",
  active: true,
  isStarter: true,
};
const extraScene: SceneSummary = {
  id: "s-cave",
  name: "Wave Echo Cave",
  active: false,
  isStarter: false,
};
const lmop: ModuleSummary = { id: "lmop", title: "Lost Mine of Phandelver", kind: "campaign" };
const ravenloft: ModuleSummary = { id: "ravenloft", title: "Ravenloft", kind: "campaign" };
const mm: PackSummary = { id: "dnd5e.monsters", label: "Monster Manual", type: "Actor" };
const lmopPack: PackSummary = { id: "lmop.monsters", label: "LMoP Monsters", type: "Actor" };
const racePackA: PackSummary = { id: "srd.races", label: "SRD Races" };
const racePackB: PackSummary = { id: "multiverse.races", label: "Multiverse Races" };

const emptyExtended = {
  loadedModules: [lmop],
  compendiumPacks: [mm],
  existingScenes: [starter],
  currentOwnershipMap: { a1: "u1" } as Record<string, string>,
  warmStateSummary: {
    priorSessionCount: 0,
    questFlagCount: 0,
    consentedPlayerCount: 0,
    mappedPlayerCount: 1,
  },
  findings: [],
};

describe("classifyCriticalGaps", () => {
  it("FOUNDRY_NOT_CONNECTED when the world is unreachable", () => {
    const findings = classifyCriticalGaps(
      { system: null, partyActorCandidates: [], connected: false },
      ctx(),
    );
    expect(findings.map((f) => f.code)).toContain("FOUNDRY_NOT_CONNECTED");
    expect(findings.every((f) => f.kind === "critical-gap")).toBe(true);
  });

  it("NO_FOUNDRY_SYSTEM when the world has no system id", () => {
    const findings = classifyCriticalGaps(
      { system: null, partyActorCandidates: party, connected: true },
      ctx(),
    );
    expect(findings.map((f) => f.code)).toContain("NO_FOUNDRY_SYSTEM");
  });

  it("UNKNOWN_FOUNDRY_SYSTEM when the system is not recognized", () => {
    const findings = classifyCriticalGaps(
      {
        system: { id: "homebrew-xyz", name: "Homebrew" },
        partyActorCandidates: party,
        connected: true,
      },
      ctx(),
    );
    const f = findings.find((x) => x.code === "UNKNOWN_FOUNDRY_SYSTEM");
    expect(f).toBeDefined();
    expect(f?.resolution?.applyOnResolve).toBe("proceed-anyway");
  });

  it("NO_PARTY_ACTORS when there are no party-actor candidates", () => {
    const findings = classifyCriticalGaps(
      { system: { id: "dnd5e", name: "D&D 5e" }, partyActorCandidates: [], connected: true },
      ctx(),
    );
    const f = findings.find((x) => x.code === "NO_PARTY_ACTORS");
    expect(f).toBeDefined();
    expect(f?.resolution).toBeUndefined();
  });

  it("MISSING_RACE_CONTENT when a mapped Fairy has no Witchlight loaded", () => {
    const findings = classifyCriticalGaps(
      {
        system: { id: "dnd5e", name: "D&D 5e" },
        partyActorCandidates: [
          { id: "a-fairy", name: "Pip", type: "character", race: "Fairy", class: "Bard" },
        ],
        connected: true,
        mappedContent: [
          {
            actorId: "a-fairy",
            race: "Fairy",
            class: "Bard",
            loadedModuleIds: ["lmop"],
            raceSourceCount: 0,
            classSourceCount: 1,
          },
        ],
      },
      ctx(),
    );
    const f = findings.find((x) => x.code === "MISSING_RACE_CONTENT");
    expect(f).toBeDefined();
    expect(f?.resolution?.applyOnResolve).toBe("proceed-anyway");
  });

  it("MISSING_CLASS_CONTENT when a mapped class has no source loaded", () => {
    const findings = classifyCriticalGaps(
      {
        system: { id: "dnd5e", name: "D&D 5e" },
        partyActorCandidates: [
          { id: "a2", name: "Hex", type: "character", race: "Human", class: "Blood Hunter" },
        ],
        connected: true,
        mappedContent: [
          {
            actorId: "a2",
            race: "Human",
            class: "Blood Hunter",
            loadedModuleIds: ["lmop"],
            raceSourceCount: 1,
            classSourceCount: 0,
          },
        ],
      },
      ctx(),
    );
    const f = findings.find((x) => x.code === "MISSING_CLASS_CONTENT");
    expect(f).toBeDefined();
    expect(f?.resolution?.applyOnResolve).toBe("proceed-anyway");
  });

  it("NO_STARTING_SCENE when no scene matches a starter convention", () => {
    const findings = classifyCriticalGaps(
      {
        system: { id: "dnd5e", name: "D&D 5e" },
        partyActorCandidates: party,
        connected: true,
        scenes: [extraScene],
      },
      ctx(),
    );
    expect(findings.map((f) => f.code)).toContain("NO_STARTING_SCENE");
  });

  it("honors a prior proceed-anyway on UNKNOWN_FOUNDRY_SYSTEM", () => {
    const findings = classifyCriticalGaps(
      {
        system: { id: "homebrew-xyz", name: "Homebrew" },
        partyActorCandidates: party,
        connected: true,
      },
      ctx({ resolvedFindings: { UNKNOWN_FOUNDRY_SYSTEM: "proceed-anyway" } }),
    );
    expect(findings.map((f) => f.code)).not.toContain("UNKNOWN_FOUNDRY_SYSTEM");
  });
});

describe("classifyAmbiguities", () => {
  it("MULTIPLE_CAMPAIGN_MODULES when two campaign modules are loaded", () => {
    const findings = classifyAmbiguities(
      { ...emptyExtended, loadedModules: [lmop, ravenloft] },
      ctx(),
    );
    const f = findings.find((x) => x.code === "MULTIPLE_CAMPAIGN_MODULES");
    expect(f?.kind).toBe("ambiguity");
    expect(f?.resolution?.applyOnResolve).toBe("module-choice");
    expect(f?.resolution?.options.map((o) => o.id)).toEqual(["lmop", "ravenloft"]);
  });

  it("AMBIG_STARTING_SCENE when two starter scenes are equally plausible", () => {
    const other: SceneSummary = {
      id: "s-intro",
      name: "Intro Tavern",
      active: false,
      isStarter: true,
    };
    const findings = classifyAmbiguities(
      { ...emptyExtended, existingScenes: [starter, other] },
      ctx(),
    );
    const f = findings.find((x) => x.code === "AMBIG_STARTING_SCENE");
    expect(f?.resolution?.applyOnResolve).toBe("scene-choice");
    expect(f?.resolution?.options).toHaveLength(2);
  });

  it("AMBIG_SOURCE_PACK_FOR_CREATURE when Goblin is in two packs", () => {
    const findings = classifyAmbiguities(
      { ...emptyExtended, creatureSources: { Goblin: [mm, lmopPack] } },
      ctx(),
    );
    const f = findings.find((x) => x.code === "AMBIG_SOURCE_PACK_FOR_CREATURE");
    expect(f?.resolution?.applyOnResolve).toBe("primary-pack-choice");
    expect(f?.resolution?.subjectKey).toBe("Goblin");
  });

  it("AMBIG_RACE_SOURCE when a mapped race is defined in two packs", () => {
    const findings = classifyAmbiguities(
      { ...emptyExtended, raceSources: { Elf: [racePackA, racePackB] } },
      ctx(),
    );
    const f = findings.find((x) => x.code === "AMBIG_RACE_SOURCE");
    expect(f?.resolution?.options.map((o) => o.id)).toEqual(["srd.races", "multiverse.races"]);
  });

  it("honors a prior chosen campaign module", () => {
    const findings = classifyAmbiguities(
      { ...emptyExtended, loadedModules: [lmop, ravenloft] },
      ctx({ resolvedFindings: {}, chosenCampaignModuleId: "lmop" }),
    );
    expect(findings.map((f) => f.code)).not.toContain("MULTIPLE_CAMPAIGN_MODULES");
  });
});

describe("classifyRecommendations", () => {
  it("RECO_PROPOSED_STARTING_SCENE when exactly one unused starter exists", () => {
    const unused: SceneSummary = {
      id: "s-start",
      name: "Session Start",
      active: false,
      isStarter: true,
    };
    const findings = classifyRecommendations(
      { ...emptyExtended, existingScenes: [unused, extraScene] },
      ctx(),
    );
    const f = findings.find((x) => x.code === "RECO_PROPOSED_STARTING_SCENE");
    expect(f?.kind).toBe("recommendation");
    expect(f?.resolution).toBeUndefined();
  });

  it("RECO_PROPOSED_OWNERSHIP_MAP when unmapped party actors have a proposed pairing", () => {
    const findings = classifyRecommendations(
      {
        ...emptyExtended,
        currentOwnershipMap: {},
        proposedOwnership: [{ actorId: "a1", actorName: "Fighter", discordLabel: "player-1" }],
      },
      ctx(),
    );
    expect(findings.map((f) => f.code)).toContain("RECO_PROPOSED_OWNERSHIP_MAP");
  });

  it("RECO_PROPOSED_PRIMARY_PACK when a default pack is proposed for a creature", () => {
    const findings = classifyRecommendations(
      {
        ...emptyExtended,
        proposedPrimaryPack: { creatureKey: "Goblin", pack: mm, namesCreature: true },
      },
      ctx(),
    );
    const f = findings.find((x) => x.code === "RECO_PROPOSED_PRIMARY_PACK");
    expect(f).toBeDefined();
  });

  it("RECO_FOUNDRY_OWNERSHIP_UNRESOLVED when user enumeration is empty", () => {
    const findings = classifyRecommendations(
      { ...emptyExtended, currentOwnershipMap: {}, usersAvailable: false },
      ctx(),
    );
    expect(findings.map((f) => f.code)).toContain("RECO_FOUNDRY_OWNERSHIP_UNRESOLVED");
  });

  it("is silent when a single starter is already active", () => {
    const findings = classifyRecommendations(emptyExtended, ctx());
    expect(findings.map((f) => f.code)).not.toContain("RECO_PROPOSED_STARTING_SCENE");
  });
});
