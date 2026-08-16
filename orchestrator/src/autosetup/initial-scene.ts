// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import type { FoundryClient } from "../foundry/client.js";
import { buildFindingSummary } from "../intake/summary.js";
import type {
  ExtendedIntakeResult,
  IntakeFinding,
  IntakeSessionConfigSlice,
  SceneSummary,
} from "../intake/types.js";

export type SceneChoice =
  | {
      kind: "unambiguous";
      sceneId: string;
      reason: "already-active" | "single-starter" | "prior-resolved";
    }
  | { kind: "ambiguous"; candidates: SceneSummary[] }
  | { kind: "none" };

export function chooseInitialScene(
  intake: ExtendedIntakeResult,
  sessionConfig: IntakeSessionConfigSlice,
): SceneChoice {
  const scenes = intake.existingScenes;
  const chosen = sessionConfig.intake?.chosenStartingSceneId;
  if (chosen !== undefined && scenes.some((s) => s.id === chosen)) {
    return { kind: "unambiguous", sceneId: chosen, reason: "prior-resolved" };
  }

  const starters = scenes.filter((s) => s.isStarter);
  const active = scenes.find((s) => s.active);

  if (active !== undefined && active.isStarter) {
    return { kind: "unambiguous", sceneId: active.id, reason: "already-active" };
  }

  if (starters.length === 1 && (active === undefined || active.id === starters[0]!.id)) {
    return { kind: "unambiguous", sceneId: starters[0]!.id, reason: "single-starter" };
  }

  if (starters.length === 0) return { kind: "none" };

  const candidates = [...starters];
  if (active !== undefined && !candidates.some((c) => c.id === active.id)) {
    candidates.push(active);
  }
  return { kind: "ambiguous", candidates };
}

export async function activateScene(foundry: FoundryClient, sceneId: string): Promise<void> {
  const current = await foundry.getActiveScene();
  if (current?.id === sceneId) return;
  await foundry.setActiveScene(sceneId);
}

export interface ApplyInitialSceneResult {
  choice: SceneChoice;
  findings: IntakeFinding[];
  actions: string[];
  activationError?: string;
}

const SCENE_CODES = new Set([
  "NO_STARTING_SCENE",
  "AMBIG_STARTING_SCENE",
  "RECO_PROPOSED_STARTING_SCENE",
]);

export function stripSceneFindings(findings: ReadonlyArray<IntakeFinding>): IntakeFinding[] {
  return findings.filter((f) => !SCENE_CODES.has(f.code));
}

export async function applyInitialScene(
  intake: ExtendedIntakeResult,
  sessionConfig: IntakeSessionConfigSlice,
  foundry: FoundryClient,
  opts?: {
    campaignId?: string;
    sessionId?: string;
    onTelemetry?: (name: string, props?: Record<string, unknown>) => void;
  },
): Promise<ApplyInitialSceneResult> {
  const choice = chooseInitialScene(intake, sessionConfig);
  const findings: IntakeFinding[] = [];
  const actions: string[] = [];

  if (choice.kind === "unambiguous") {
    const scene = intake.existingScenes.find((s) => s.id === choice.sceneId);
    const name = scene?.name ?? choice.sceneId;
    try {
      await activateScene(foundry, choice.sceneId);
      actions.push(`Activated starting scene ${name}.`);
      findings.push({
        code: "RECO_PROPOSED_STARTING_SCENE",
        kind: "recommendation",
        summary: `I activated ${name}.`,
        dmOnly: true,
      });
      opts?.onTelemetry?.("autosetup.scene.activated", {
        campaignId: opts.campaignId ?? "",
        sessionId: opts.sessionId ?? "",
        reason: choice.reason,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        choice,
        findings,
        actions,
        activationError: `I tried to activate ${name} and the bridge returned: ${message}`,
      };
    }
    return { choice, findings, actions };
  }

  if (choice.kind === "ambiguous") {
    findings.push(
      frame({
        code: "AMBIG_STARTING_SCENE",
        kind: "ambiguity",
        summary: "More than one scene could be tonight's starting beat.",
        dmOnly: true,
        resolution: {
          prompt: "Which scene should we start in?",
          options: choice.candidates.map((s) => ({ id: s.id, label: s.name })),
          applyOnResolve: "scene-choice",
        },
      }),
    );
    opts?.onTelemetry?.("autosetup.scene.deferred", {
      campaignId: opts.campaignId ?? "",
      sessionId: opts.sessionId ?? "",
      candidateCount: choice.candidates.length,
    });
    return { choice, findings, actions };
  }

  findings.push(
    frame({
      code: "NO_STARTING_SCENE",
      kind: "critical-gap",
      summary: "No scene matches a starting-scene convention.",
      dmOnly: false,
    }),
  );
  return { choice, findings, actions };
}

function frame(finding: IntakeFinding): IntakeFinding {
  const framed = buildFindingSummary(finding.code, {
    label: finding.summary,
    namesCreatureOrLocation: finding.dmOnly,
  });
  return {
    ...finding,
    dmOnly: framed.dmOnly,
    ...(framed.detail !== undefined ? { detail: framed.detail } : {}),
  };
}
