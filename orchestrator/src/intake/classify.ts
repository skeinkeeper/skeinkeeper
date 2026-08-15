// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { isKnownFoundrySystem } from "./foundry_reads.js";
import type {
  ActorSummary,
  ExtendedIntakeResult,
  FindingCode,
  IntakeContext,
  IntakeFinding,
  ModuleSummary,
  PackSummary,
  ResolutionOptions,
  SceneSummary,
} from "./types.js";

const SRD_RACES = new Set([
  "dwarf",
  "elf",
  "halfling",
  "human",
  "dragonborn",
  "gnome",
  "half-elf",
  "half-orc",
  "tiefling",
  "half elf",
  "half orc",
]);

const SRD_CLASSES = new Set([
  "barbarian",
  "bard",
  "cleric",
  "druid",
  "fighter",
  "monk",
  "paladin",
  "ranger",
  "rogue",
  "sorcerer",
  "warlock",
  "wizard",
]);

/** Non-SRD races → module id fragments that supply them. */
const EXTRA_RACE_MODULES: Record<string, ReadonlyArray<string>> = {
  fairy: ["witchlight", "multiverse"],
  harengon: ["witchlight", "multiverse"],
  owlin: ["strixhaven"],
  leonin: ["theros"],
  satyr: ["theros"],
};

export interface MappedContentGap {
  actorId: string;
  race?: string;
  class?: string;
  loadedModuleIds: string[];
  raceSourceCount: number;
  classSourceCount: number;
}

export interface CriticalGapInput {
  system: { id: string; name: string } | null;
  partyActorCandidates: ActorSummary[];
  connected: boolean;
  mappedContent?: ReadonlyArray<MappedContentGap>;
  scenes?: ReadonlyArray<SceneSummary>;
}

export interface ExtendedClassifyInput extends ExtendedIntakeResult {
  creatureSources?: Record<string, ReadonlyArray<PackSummary>>;
  raceSources?: Record<string, ReadonlyArray<PackSummary>>;
  proposedOwnership?: ReadonlyArray<{ actorId: string; actorName: string; discordLabel: string }>;
  proposedPrimaryPack?: { creatureKey: string; pack: PackSummary; namesCreature: boolean };
  usersAvailable?: boolean;
}

export function classifyCriticalGaps(input: CriticalGapInput, ctx: IntakeContext): IntakeFinding[] {
  const out: IntakeFinding[] = [];
  const skip = resolvedSet(ctx);

  if (!input.connected) {
    push(out, skip, {
      code: "FOUNDRY_NOT_CONNECTED",
      kind: "critical-gap",
      summary: "Foundry is not connected.",
      dmOnly: false,
    });
    return out;
  }

  if (input.system === null || input.system.id.trim().length === 0) {
    push(out, skip, {
      code: "NO_FOUNDRY_SYSTEM",
      kind: "critical-gap",
      summary: "No Foundry game system is active.",
      dmOnly: false,
    });
  } else if (!isKnownFoundrySystem(input.system.id)) {
    push(out, skip, {
      code: "UNKNOWN_FOUNDRY_SYSTEM",
      kind: "critical-gap",
      summary: `Unrecognized Foundry system "${input.system.id}".`,
      dmOnly: false,
      resolution: proceedAnyway("Proceed with system-agnostic behavior?"),
    });
  }

  if (input.partyActorCandidates.length === 0) {
    push(out, skip, {
      code: "NO_PARTY_ACTORS",
      kind: "critical-gap",
      summary: "No party-actor candidates in the Foundry world.",
      dmOnly: false,
    });
  }

  for (const mapped of input.mappedContent ?? []) {
    if (mapped.race !== undefined && isMissingRace(mapped)) {
      push(out, skip, {
        code: "MISSING_RACE_CONTENT",
        kind: "critical-gap",
        summary: `Required race content for "${mapped.race}" is not loaded.`,
        dmOnly: false,
        resolution: proceedAnyway("Proceed anyway and improvise from SRD-adjacent content?"),
      });
    }
    if (mapped.class !== undefined && isMissingClass(mapped)) {
      push(out, skip, {
        code: "MISSING_CLASS_CONTENT",
        kind: "critical-gap",
        summary: `Required class content for "${mapped.class}" is not loaded.`,
        dmOnly: false,
        resolution: proceedAnyway("Proceed anyway and improvise from SRD-adjacent content?"),
      });
    }
  }

  if (input.scenes !== undefined) {
    const chosen = ctx.sessionConfig.intake?.chosenStartingSceneId;
    const chosenExists = chosen !== undefined && input.scenes.some((s) => s.id === chosen);
    const starters = input.scenes.filter((s) => s.isStarter);
    if (!chosenExists && starters.length === 0) {
      push(out, skip, {
        code: "NO_STARTING_SCENE",
        kind: "critical-gap",
        summary: "No scene matches a starting-scene convention.",
        dmOnly: false,
      });
    }
  }

  return out;
}

export function classifyAmbiguities(
  input: ExtendedClassifyInput,
  ctx: IntakeContext,
): IntakeFinding[] {
  const out: IntakeFinding[] = [];
  const skip = resolvedSet(ctx);
  const intake = ctx.sessionConfig.intake;

  const campaignModules = input.loadedModules.filter((m) => m.kind === "campaign");
  const chosenModule = intake?.chosenCampaignModuleId;
  const chosenModuleLoaded =
    chosenModule !== undefined && campaignModules.some((m) => m.id === chosenModule);
  if (campaignModules.length > 1 && !chosenModuleLoaded) {
    push(out, skip, {
      code: "MULTIPLE_CAMPAIGN_MODULES",
      kind: "ambiguity",
      summary: "More than one campaign module is loaded.",
      dmOnly: false,
      resolution: choice(
        "Which campaign should I run tonight?",
        campaignModules.map((m) => ({ id: m.id, label: m.title })),
        "module-choice",
      ),
    });
  }

  const starters = input.existingScenes.filter((s) => s.isStarter);
  const chosenScene = intake?.chosenStartingSceneId;
  const chosenSceneExists =
    chosenScene !== undefined && input.existingScenes.some((s) => s.id === chosenScene);
  if (starters.length > 1 && !chosenSceneExists) {
    push(out, skip, {
      code: "AMBIG_STARTING_SCENE",
      kind: "ambiguity",
      summary: "More than one scene could be tonight's starting beat.",
      dmOnly: true,
      resolution: choice(
        "Which scene should we start in?",
        starters.map((s) => ({ id: s.id, label: s.name })),
        "scene-choice",
      ),
    });
  }

  for (const [creature, packs] of Object.entries(input.creatureSources ?? {})) {
    const preferred = intake?.primarySourcePackByCreatureKey?.[creature];
    if (packs.length > 1 && (preferred === undefined || !packs.some((p) => p.id === preferred))) {
      push(out, skip, {
        code: "AMBIG_SOURCE_PACK_FOR_CREATURE",
        kind: "ambiguity",
        summary: "The same creature is present in more than one pack.",
        dmOnly: true,
        resolution: {
          ...choice(
            "Which pack should I use for this creature?",
            packs.map((p) => ({ id: p.id, label: p.label })),
            "primary-pack-choice",
          ),
          subjectKey: creature,
        },
      });
    }
  }

  for (const [race, packs] of Object.entries(input.raceSources ?? {})) {
    if (packs.length > 1) {
      push(out, skip, {
        code: "AMBIG_RACE_SOURCE",
        kind: "ambiguity",
        summary: `Race "${race}" is defined in more than one source.`,
        dmOnly: false,
        resolution: {
          ...choice(
            `Which source should I use for ${race}?`,
            packs.map((p) => ({ id: p.id, label: p.label })),
            "primary-pack-choice",
          ),
          subjectKey: race,
        },
      });
    }
  }

  return out;
}

export function classifyRecommendations(
  input: ExtendedClassifyInput,
  ctx: IntakeContext,
): IntakeFinding[] {
  const out: IntakeFinding[] = [];
  const skip = resolvedSet(ctx);
  const chosenScene = ctx.sessionConfig.intake?.chosenStartingSceneId;
  const starters = input.existingScenes.filter((s) => s.isStarter);
  if (starters.length === 1 && chosenScene === undefined && starters[0]!.active === false) {
    push(out, skip, {
      code: "RECO_PROPOSED_STARTING_SCENE",
      kind: "recommendation",
      summary: `Proposed starting scene: ${starters[0]!.name}.`,
      dmOnly: true,
    });
  }

  if ((input.proposedOwnership?.length ?? 0) > 0) {
    push(out, skip, {
      code: "RECO_PROPOSED_OWNERSHIP_MAP",
      kind: "recommendation",
      summary: "Proposed character-to-player pairings are ready to confirm.",
      dmOnly: false,
    });
  }

  if (input.proposedPrimaryPack !== undefined) {
    const p = input.proposedPrimaryPack;
    push(out, skip, {
      code: "RECO_PROPOSED_PRIMARY_PACK",
      kind: "recommendation",
      summary: `Proposed primary pack: ${p.pack.label}.`,
      dmOnly: p.namesCreature,
    });
  }

  if (input.usersAvailable === false) {
    push(out, skip, {
      code: "RECO_FOUNDRY_OWNERSHIP_UNRESOLVED",
      kind: "recommendation",
      summary: "Could not enumerate Foundry users to confirm actor ownership.",
      dmOnly: false,
    });
  }

  return out;
}

function isMissingRace(mapped: MappedContentGap): boolean {
  const race = mapped.race?.trim() ?? "";
  if (race.length === 0) return false;
  if (SRD_RACES.has(race.toLowerCase())) return false;
  if (mapped.raceSourceCount > 0) return false;
  const needed = EXTRA_RACE_MODULES[race.toLowerCase()];
  if (needed !== undefined && moduleMatches(mapped.loadedModuleIds, needed)) return false;
  return true;
}

function isMissingClass(mapped: MappedContentGap): boolean {
  const klass = mapped.class?.trim() ?? "";
  if (klass.length === 0) return false;
  if (SRD_CLASSES.has(klass.toLowerCase())) return false;
  return mapped.classSourceCount === 0;
}

function moduleMatches(loaded: ReadonlyArray<string>, fragments: ReadonlyArray<string>): boolean {
  return loaded.some((id) => fragments.some((f) => id.toLowerCase().includes(f)));
}

function resolvedSet(ctx: IntakeContext): ReadonlySet<FindingCode> {
  return new Set(Object.keys(ctx.sessionConfig.intake?.resolvedFindings ?? {}) as FindingCode[]);
}

function push(out: IntakeFinding[], skip: ReadonlySet<FindingCode>, finding: IntakeFinding): void {
  if (skip.has(finding.code)) return;
  out.push(finding);
}

function proceedAnyway(prompt: string): ResolutionOptions {
  return {
    prompt,
    options: [{ id: "proceed-anyway", label: "Proceed anyway" }],
    applyOnResolve: "proceed-anyway",
  };
}

function choice(
  prompt: string,
  options: Array<{ id: string; label: string }>,
  applyOnResolve: ResolutionOptions["applyOnResolve"],
): ResolutionOptions {
  return { prompt, options, applyOnResolve };
}

export function campaignModulesOf(modules: ReadonlyArray<ModuleSummary>): ModuleSummary[] {
  return modules.filter((m) => m.kind === "campaign");
}
