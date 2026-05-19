// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import type { FoundryActor } from "./client.js";

/**
 * Per-system actor renderer. Produces a one-line summary suitable for
 * the LLM's hot-context block. Per design doc 0007, the orchestrator
 * doesn't validate Foundry's `actor.system` shape; the system module
 * is authoritative. These renderers just know enough about each
 * supported system to surface the most useful state for the AI DM.
 *
 * Unknown systems fall back to `renderGeneric`, which inspects the
 * sheet for recognizable top-level fields and prints them.
 */
export function renderActorState(actor: FoundryActor): string {
  switch (actor.system) {
    case "dnd5e":
      return renderDnd5e(actor);
    case "fate-core":
      return renderFateCore(actor);
    case "dungeon-world":
      return renderDungeonWorld(actor);
    default:
      return renderGeneric(actor);
  }
}

function getNested(obj: unknown, ...path: string[]): unknown {
  let cur = obj;
  for (const key of path) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

function renderDnd5e(actor: FoundryActor): string {
  const hp = getNested(actor.sheet, "attributes", "hp", "value");
  const maxHp = getNested(actor.sheet, "attributes", "hp", "max");
  const ac = getNested(actor.sheet, "attributes", "ac", "value");
  const conditions = getNested(actor.sheet, "conditions");
  const condList = Array.isArray(conditions) ? (conditions as string[]) : [];

  const parts: string[] = [actor.name];
  if (typeof hp === "number" && typeof maxHp === "number") {
    parts.push(`HP ${hp}/${maxHp}`);
  }
  if (typeof ac === "number") {
    parts.push(`AC ${ac}`);
  }
  if (condList.length > 0) {
    parts.push(`[${condList.join(", ")}]`);
  }
  return parts.join(" — ").replace(" — [", " [");
}

function renderFateCore(actor: FoundryActor): string {
  const physical = getNested(actor.sheet, "stress", "physical");
  const mental = getNested(actor.sheet, "stress", "mental");
  const consequences = getNested(actor.sheet, "consequences");
  const aspects = getNested(actor.sheet, "aspects");

  const parts: string[] = [actor.name];
  if (Array.isArray(physical)) {
    const filled = (physical as boolean[]).filter(Boolean).length;
    parts.push(`physical ${filled}/${physical.length}`);
  }
  if (Array.isArray(mental)) {
    const filled = (mental as boolean[]).filter(Boolean).length;
    parts.push(`mental ${filled}/${mental.length}`);
  }
  if (Array.isArray(consequences)) {
    const taken = (consequences as Array<{ severity?: string; text?: string }>).filter((c) => c.text);
    if (taken.length > 0) {
      parts.push(
        `consequences: ${taken.map((c) => `${c.severity ?? "?"}: "${c.text ?? ""}"`).join("; ")}`,
      );
    }
  }
  if (Array.isArray(aspects) && aspects.length > 0) {
    const firstFew = (aspects as Array<{ text?: string }>)
      .slice(0, 3)
      .map((a) => `"${a.text ?? ""}"`)
      .join(", ");
    parts.push(`aspects: ${firstFew}`);
  }
  return parts.join(" — ");
}

function renderDungeonWorld(actor: FoundryActor): string {
  const hp = getNested(actor.sheet, "attributes", "hp", "value");
  const maxHp = getNested(actor.sheet, "attributes", "hp", "max");
  const armor = getNested(actor.sheet, "attributes", "armor", "value");
  const debilities = getNested(actor.sheet, "debilities");

  const parts: string[] = [actor.name];
  if (typeof hp === "number" && typeof maxHp === "number") {
    parts.push(`HP ${hp}/${maxHp}`);
  }
  if (typeof armor === "number") {
    parts.push(`armor ${armor}`);
  }
  if (debilities && typeof debilities === "object") {
    const active = Object.entries(debilities as Record<string, unknown>)
      .filter(([, v]) => v === true)
      .map(([k]) => k);
    if (active.length > 0) parts.push(`debilities: ${active.join(", ")}`);
  }
  return parts.join(" — ");
}

function renderGeneric(actor: FoundryActor): string {
  const parts: string[] = [actor.name];
  // Look for common health-ish fields under .system
  const hpCandidates: Array<[string, unknown]> = [];
  const sheet = actor.sheet;
  for (const key of ["hp", "stress", "harm", "health", "wounds"]) {
    const v = sheet[key];
    if (v !== undefined) hpCandidates.push([key, v]);
  }
  for (const [key, v] of hpCandidates) {
    if (typeof v === "number") parts.push(`${key} ${v}`);
    else if (typeof v === "object" && v !== null) {
      const obj = v as Record<string, unknown>;
      if (typeof obj.value === "number" && typeof obj.max === "number") {
        parts.push(`${key} ${obj.value}/${obj.max}`);
      } else {
        parts.push(`${key} ${JSON.stringify(v)}`);
      }
    } else {
      parts.push(`${key} ${String(v)}`);
    }
  }
  if (hpCandidates.length === 0) {
    parts.push(`(system ${actor.system}, no rendered state)`);
  }
  return parts.join(" — ");
}
