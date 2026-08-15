// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

/**
 * Cross-TDD intake types (TDD 0031). Autosetup (TDD 0032) imports these
 * from this path. This module has no runtime dependencies — the
 * FINDING_CODES table is a string-literal list only.
 */

export const FINDING_CODES = [
  "NO_FOUNDRY_SYSTEM",
  "UNKNOWN_FOUNDRY_SYSTEM",
  "FOUNDRY_NOT_CONNECTED",
  "NO_PARTY_ACTORS",
  "MISSING_RACE_CONTENT",
  "MISSING_CLASS_CONTENT",
  "NO_STARTING_SCENE",
  "MULTIPLE_CAMPAIGN_MODULES",
  "AMBIG_STARTING_SCENE",
  "AMBIG_SOURCE_PACK_FOR_CREATURE",
  "AMBIG_RACE_SOURCE",
  "RECO_PROPOSED_STARTING_SCENE",
  "RECO_PROPOSED_OWNERSHIP_MAP",
  "RECO_PROPOSED_PRIMARY_PACK",
  "RECO_FOUNDRY_OWNERSHIP_UNRESOLVED",
] as const;

export type FindingCode = (typeof FINDING_CODES)[number];

export type FindingKind = "critical-gap" | "ambiguity" | "recommendation";

export type ApplyOnResolve =
  | "scene-choice"
  | "module-choice"
  | "primary-pack-choice"
  | "ownership-map"
  | "proceed-anyway";

export type ActorId = string;
export type FoundryUserId = string;

export function isFindingCode(value: string): value is FindingCode {
  return (FINDING_CODES as readonly string[]).includes(value);
}

/** Per-campaign intake decisions honored on the next Start. */
export interface SessionIntakeConfig {
  resolvedFindings: Partial<Record<FindingCode, string>>;
  chosenStartingSceneId?: string;
  primarySourcePackByCreatureKey?: Record<string, string>;
  chosenCampaignModuleId?: string;
}

/**
 * The SessionConfig slice intake reads. Full SessionConfig lives in
 * session.ts and adds this as `intake?`; types stay free of session
 * runtime imports (TDD 0031 cross-TDD contract).
 */
export interface IntakeSessionConfigSlice {
  intake?: SessionIntakeConfig;
}

export interface IntakeContext {
  campaignId: string;
  sessionId: string;
  sessionConfig: IntakeSessionConfigSlice;
}

export interface ActorSummary {
  id: ActorId;
  name: string;
  type: string;
  race?: string;
  class?: string;
}

export interface SceneSummary {
  id: string;
  name: string;
  active: boolean;
  isStarter: boolean;
}

export interface ModuleSummary {
  id: string;
  title: string;
  kind: "campaign" | "system" | "utility";
}

export interface PackSummary {
  id: string;
  label: string;
  type?: string;
}

export interface WarmStateSummary {
  priorSessionCount: number;
  questFlagCount: number;
  consentedPlayerCount: number;
  mappedPlayerCount: number;
}

export interface MinimumIntakeResult {
  system: { id: string; name: string } | null;
  partyActorCandidates: ActorSummary[];
  criticalFindings: IntakeFinding[];
}

export interface ExtendedIntakeResult {
  loadedModules: ModuleSummary[];
  compendiumPacks: PackSummary[];
  existingScenes: SceneSummary[];
  currentOwnershipMap: Record<ActorId, FoundryUserId>;
  warmStateSummary: WarmStateSummary;
  findings: IntakeFinding[];
}

export interface ResolutionOptions {
  prompt: string;
  options: Array<{ id: string; label: string }>;
  applyOnResolve: ApplyOnResolve;
  /** Creature key / race name / discord user id the choice applies to. */
  subjectKey?: string;
}

export interface IntakeFinding {
  /** Persisted row id once the finding is written to session_intake_finding. */
  id?: number;
  code: FindingCode;
  kind: FindingKind;
  summary: string;
  detail?: string;
  dmOnly: boolean;
  resolution?: ResolutionOptions;
}

/**
 * Structured operator-message payload. Today the text is handed to
 * `notify_operator` (Discord DM). TDD 0034 re-homes delivery to Foundry
 * GM chat via SurfaceRouter; keep this shape stable for that swap.
 */
export interface IntakeOperatorPayload {
  text: string;
  findings: ReadonlyArray<IntakeFinding>;
  delivery: "notify_operator";
  /** True when any finding carries DM-only context. */
  dmOnly: boolean;
}

/**
 * Hook TDD 0032 wires to `activateScene`. This TDD calls it from the
 * `scene-choice` applyOnResolve path only.
 */
export type SceneChoiceApplyHook = (sceneId: string) => Promise<void>;

export type IntakeResolveStatus = "resolved" | "already-resolved" | "no-longer-applicable";

export interface IntakeResolveResult {
  status: IntakeResolveStatus;
  finding?: IntakeFinding;
  intake?: SessionIntakeConfig;
}
