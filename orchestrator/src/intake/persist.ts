// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import type { TenantDb } from "@skeinkeeper/server";
import type { IntakeFinding, SessionIntakeConfig } from "./types.js";

export const INTAKE_SETTING_KEY = "intake.config";

export function emptyIntakeConfig(): SessionIntakeConfig {
  return { resolvedFindings: {} };
}

export function parseIntakeConfig(raw: string | undefined): SessionIntakeConfig {
  if (raw === undefined || raw.length === 0) return emptyIntakeConfig();
  try {
    const parsed = JSON.parse(raw) as Partial<SessionIntakeConfig>;
    const resolved =
      parsed.resolvedFindings !== undefined && typeof parsed.resolvedFindings === "object"
        ? parsed.resolvedFindings
        : {};
    const cfg: SessionIntakeConfig = { resolvedFindings: { ...resolved } };
    if (typeof parsed.chosenStartingSceneId === "string") {
      cfg.chosenStartingSceneId = parsed.chosenStartingSceneId;
    }
    if (typeof parsed.chosenCampaignModuleId === "string") {
      cfg.chosenCampaignModuleId = parsed.chosenCampaignModuleId;
    }
    if (parsed.primarySourcePackByCreatureKey !== undefined) {
      cfg.primarySourcePackByCreatureKey = { ...parsed.primarySourcePackByCreatureKey };
    }
    return cfg;
  } catch {
    return emptyIntakeConfig();
  }
}

export function serializeIntakeConfig(cfg: SessionIntakeConfig): string {
  return JSON.stringify(cfg);
}

export function loadIntakeConfig(tenantDb: TenantDb, campaignId: string): SessionIntakeConfig {
  return parseIntakeConfig(tenantDb.settings.get(campaignId, INTAKE_SETTING_KEY)?.value);
}

export function saveIntakeConfig(
  tenantDb: TenantDb,
  campaignId: string,
  cfg: SessionIntakeConfig,
): void {
  tenantDb.settings.set({
    campaignId,
    key: INTAKE_SETTING_KEY,
    value: serializeIntakeConfig(cfg),
    updatedAt: Date.now(),
  });
}

/** Persist operator-visible escalations (criticals + ambiguities). */
export function persistSurfacedFindings(
  tenantDb: TenantDb,
  campaignId: string,
  sessionId: string,
  findings: ReadonlyArray<IntakeFinding>,
): IntakeFinding[] {
  const now = Date.now();
  return findings.map((f) => {
    if (f.kind === "recommendation") return f;
    if (f.id !== undefined) return f;
    const row = tenantDb.sessionIntakeFindings.insert({
      campaignId,
      sessionId,
      findingCode: f.code,
      kind: f.kind,
      summary: f.summary,
      ...(f.detail !== undefined ? { detail: f.detail } : {}),
      dmOnly: f.dmOnly,
      createdAt: now,
    });
    return { ...f, id: row.id };
  });
}

export function persistFindingResolution(
  tenantDb: TenantDb,
  findingId: number,
  optionId: string,
): void {
  tenantDb.sessionIntakeFindings.markResolved(findingId, optionId, Date.now());
}
