// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { describe, expect, it } from "vitest";
import { parseNarrationSegments, normalizeNpcKey } from "./markers.js";

describe("parseNarrationSegments", () => {
  it("treats marker-free narration as a single DM segment", () => {
    const segs = parseNarrationSegments("The cavern yawns before you.");
    expect(segs).toEqual([{ kind: "dm", text: "The cavern yawns before you." }]);
  });

  it("splits DM narration from an NPC line", () => {
    const segs = parseNarrationSegments(
      'Sildar steps forward. [NPC:sildar] "We have to flee."',
    );
    expect(segs).toEqual([
      { kind: "dm", text: "Sildar steps forward." },
      { kind: "npc", npcKey: "sildar", text: '"We have to flee."' },
    ]);
  });

  it("handles multiple NPCs in sequence", () => {
    const segs = parseNarrationSegments(
      '[NPC:Gundren] "Help me!" [NPC:Klarg] "Crush them!"',
    );
    expect(segs).toEqual([
      { kind: "npc", npcKey: "gundren", text: '"Help me!"' },
      { kind: "npc", npcKey: "klarg", text: '"Crush them!"' },
    ]);
  });

  it("normalizes NPC keys (case + whitespace)", () => {
    const segs = parseNarrationSegments('[NPC:  Sildar Hallwinter ] "Hold."');
    expect(segs[0]).toEqual({ kind: "npc", npcKey: "sildar hallwinter", text: '"Hold."' });
  });

  it("drops empty segments around adjacent markers", () => {
    const segs = parseNarrationSegments('[NPC:a]   [NPC:b] "Only B speaks."');
    expect(segs).toEqual([{ kind: "npc", npcKey: "b", text: '"Only B speaks."' }]);
  });

  it("normalizeNpcKey lowercases and collapses whitespace", () => {
    expect(normalizeNpcKey("  The   Goblin King ")).toBe("the goblin king");
  });
});
