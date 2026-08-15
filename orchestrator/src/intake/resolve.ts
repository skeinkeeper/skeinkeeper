// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import type { FoundryClient } from "../foundry/client.js";
import type {
  IntakeFinding,
  IntakeResolveResult,
  SceneChoiceApplyHook,
  SessionIntakeConfig,
} from "./types.js";

export interface IntakeResolutionState {
  findings: IntakeFinding[];
  resolvedIds: Set<number>;
  intake: SessionIntakeConfig;
}

export function createIntakeResolutionState(
  findings: ReadonlyArray<IntakeFinding>,
  intake: SessionIntakeConfig = { resolvedFindings: {} },
): IntakeResolutionState {
  const resolvedIds = new Set<number>();
  for (const finding of findings) {
    if (finding.id !== undefined && intake.resolvedFindings[finding.code] !== undefined) {
      resolvedIds.add(finding.id);
    }
  }
  return {
    findings: [...findings],
    resolvedIds,
    intake: {
      resolvedFindings: { ...intake.resolvedFindings },
      ...(intake.chosenStartingSceneId !== undefined
        ? { chosenStartingSceneId: intake.chosenStartingSceneId }
        : {}),
      ...(intake.chosenCampaignModuleId !== undefined
        ? { chosenCampaignModuleId: intake.chosenCampaignModuleId }
        : {}),
      ...(intake.primarySourcePackByCreatureKey !== undefined
        ? { primarySourcePackByCreatureKey: { ...intake.primarySourcePackByCreatureKey } }
        : {}),
    },
  };
}

export interface IntakeResolutionHooks {
  foundry?: FoundryClient;
  /** TDD 0032 wires activateScene here. */
  onSceneChoice?: SceneChoiceApplyHook;
}

/**
 * Single write path for intake finding resolution (TDD 0031).
 * TDD 0040 will add the Foundry chat-command `/skeinkeeper intake resolve`
 * against this same function; the web console already calls it.
 */
export async function applyIntakeResolution(
  state: IntakeResolutionState,
  findingId: number,
  optionId: string,
  hooks: IntakeResolutionHooks = {},
): Promise<IntakeResolveResult> {
  const finding = state.findings.find((f) => f.id === findingId);
  if (finding === undefined) return { status: "no-longer-applicable" };
  if (state.resolvedIds.has(findingId)) {
    return { status: "already-resolved", finding, intake: state.intake };
  }
  const options = finding.resolution?.options ?? [];
  if (options.length === 0 || !options.some((o) => o.id === optionId)) {
    return { status: "no-longer-applicable", finding, intake: state.intake };
  }

  const apply = finding.resolution?.applyOnResolve;
  if (apply === "scene-choice") {
    state.intake.chosenStartingSceneId = optionId;
    if (hooks.onSceneChoice !== undefined) await hooks.onSceneChoice(optionId);
    else if (hooks.foundry !== undefined) await hooks.foundry.setActiveScene(optionId);
  } else if (apply === "module-choice") {
    state.intake.chosenCampaignModuleId = optionId;
  } else if (apply === "primary-pack-choice") {
    const key = finding.resolution?.subjectKey ?? finding.code;
    state.intake.primarySourcePackByCreatureKey = {
      ...(state.intake.primarySourcePackByCreatureKey ?? {}),
      [key]: optionId,
    };
  }

  state.intake.resolvedFindings[finding.code] = optionId;
  state.resolvedIds.add(findingId);
  return { status: "resolved", finding, intake: state.intake };
}

export function unresolvedCriticalCodes(state: IntakeResolutionState): string[] {
  return state.findings
    .filter((f) => f.kind === "critical-gap" && f.id !== undefined && !state.resolvedIds.has(f.id))
    .map((f) => f.code);
}

export function announceReadyAllowed(state: IntakeResolutionState): boolean {
  return unresolvedCriticalCodes(state).length === 0;
}
