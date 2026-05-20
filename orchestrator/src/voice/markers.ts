// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

/**
 * Narration marker parser (design doc 0017). The AI DM's narration carries
 * inline voice markers — `[NPC:sildar] "We have to flee."` — to switch from
 * the DM voice to an NPC voice. This pure function splits a narration string
 * into ordered segments, each tagged with the voice that should speak it.
 *
 * Rules:
 *  - Text before the first marker is the DM voice.
 *  - A `[NPC:key]` marker applies to all text after it, until the next marker.
 *  - NPC keys are normalized (lowercased, trimmed) so "Sildar" and "sildar"
 *    resolve to the same persisted assignment.
 *  - Empty/whitespace-only segments are dropped.
 */
export type NarrationSegment =
  | { kind: "dm"; text: string }
  | { kind: "npc"; npcKey: string; text: string };

const MARKER = /\[NPC:\s*([^\]]+?)\s*\]/gi;

export function normalizeNpcKey(raw: string): string {
  return raw.toLowerCase().replace(/\s+/g, " ").trim();
}

function push(segments: NarrationSegment[], npcKey: string | null, raw: string): void {
  const text = raw.trim();
  if (text.length === 0) return;
  if (npcKey === null) {
    segments.push({ kind: "dm", text });
  } else {
    segments.push({ kind: "npc", npcKey, text });
  }
}

export function parseNarrationSegments(narration: string): NarrationSegment[] {
  const segments: NarrationSegment[] = [];
  let lastIndex = 0;
  let currentNpc: string | null = null;
  MARKER.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MARKER.exec(narration)) !== null) {
    push(segments, currentNpc, narration.slice(lastIndex, m.index));
    currentNpc = normalizeNpcKey(m[1]!);
    lastIndex = MARKER.lastIndex;
  }
  push(segments, currentNpc, narration.slice(lastIndex));
  return segments;
}
