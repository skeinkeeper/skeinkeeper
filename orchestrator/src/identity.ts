// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import type { FoundryActor } from "./foundry/client.js";

/**
 * Fuzzy resolution of a spoken character name to a Foundry actor, used
 * during the session-start intro ritual (design doc 0016). The AI
 * primarily resolves from the party it already sees in hot context; this
 * pure helper backs that with a deterministic matcher (and gives the flow
 * something unit-testable).
 */

export interface NameResolution {
  /** The single best match, or null if none/ambiguous. */
  match: FoundryActor | null;
  /** True when ≥2 candidates tie for the top score — the AI should ask. */
  ambiguous: boolean;
  /** All actors that scored above the floor, best first. */
  candidates: ReadonlyArray<FoundryActor>;
}

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Score how well a spoken name matches an actor name. 0 = no match. */
function scoreName(spoken: string, actorName: string): number {
  const a = normalize(spoken);
  const b = normalize(actorName);
  if (a.length === 0 || b.length === 0) return 0;
  if (a === b) return 1;

  const aTokens = new Set(a.split(" "));
  const bTokens = b.split(" ");

  // Spoken name equals the actor's first token ("Aragorn" ~ "Aragorn, Ranger").
  if (bTokens[0] !== undefined && aTokens.has(bTokens[0])) return 0.9;

  // Token overlap fraction (of the spoken name's tokens that appear in actor).
  const overlap = [...aTokens].filter((t) => bTokens.includes(t)).length;
  if (overlap > 0) return 0.5 + 0.3 * (overlap / aTokens.size);

  // Substring either direction.
  if (b.includes(a) || a.includes(b)) return 0.6;

  return 0;
}

const MATCH_FLOOR = 0.5;
const TIE_MARGIN = 0.1;

export function resolveCharacterName(
  spokenName: string,
  actors: ReadonlyArray<FoundryActor>,
): NameResolution {
  const scored = actors
    .map((actor) => ({ actor, score: scoreName(spokenName, actor.name) }))
    .filter((s) => s.score >= MATCH_FLOOR)
    .sort((x, y) => y.score - x.score);

  if (scored.length === 0) {
    return { match: null, ambiguous: false, candidates: [] };
  }

  const candidates = scored.map((s) => s.actor);
  const top = scored[0]!;
  const runnerUp = scored[1];
  const ambiguous = runnerUp !== undefined && top.score - runnerUp.score < TIE_MARGIN;

  return {
    match: ambiguous ? null : top.actor,
    ambiguous,
    candidates,
  };
}
