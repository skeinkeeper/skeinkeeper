// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { describe, expect, it } from "vitest";
import {
  assembleHotContext,
  formatHotContextAsText,
  type DialogueTurn,
  type WarmStateSnapshot,
} from "./hot_context.js";
import type { FoundryActor } from "./foundry/client.js";

function dnd5eCharacter(
  name: string,
  hp: number,
  maxHp: number,
  conditions: string[] = [],
): FoundryActor {
  return {
    id: `ch-${name}`,
    name,
    type: "character",
    system: "dnd5e",
    sheet: {
      attributes: { hp: { value: hp, max: maxHp }, ac: { value: 16 } },
      conditions,
    },
  };
}

function dnd5eNpc(name: string): FoundryActor {
  return {
    id: `npc-${name}`,
    name,
    type: "npc",
    system: "dnd5e",
    sheet: { attributes: { hp: { value: 12, max: 12 } } },
  };
}

function warm(): WarmStateSnapshot {
  return {
    campaign: { id: "phandelver", name: "Lost Mine of Phandelver", rulesetId: "dnd5e" },
    party: [
      dnd5eCharacter("Aragorn", 22, 30),
      dnd5eCharacter("Gimli", 8, 28, ["frightened"]),
    ],
    activeNpcs: [dnd5eNpc("Sildar")],
    currentLocation: { id: "scene-1", name: "Phandalin Town Square", description: "Dusty and quiet." },
  };
}

function turns(n: number): DialogueTurn[] {
  const out: DialogueTurn[] = [];
  for (let i = 0; i < n; i++) {
    out.push({ speaker: "player", text: `turn ${i}`, timestamp: i });
  }
  return out;
}

describe("assembleHotContext", () => {
  it("includes all warm state fields verbatim", () => {
    const ctx = assembleHotContext(warm(), turns(3));
    expect(ctx.campaign.name).toBe("Lost Mine of Phandelver");
    expect(ctx.party).toHaveLength(2);
    expect(ctx.activeNpcs[0]?.name).toBe("Sildar");
    expect(ctx.currentLocation?.name).toBe("Phandalin Town Square");
  });

  it("takes the most recent N turns when history exceeds the window", () => {
    const ctx = assembleHotContext(warm(), turns(50), { windowSize: 10 });
    expect(ctx.recentDialogue).toHaveLength(10);
    expect(ctx.recentDialogue[0]?.text).toBe("turn 40");
    expect(ctx.recentDialogue[9]?.text).toBe("turn 49");
  });

  it("returns all turns when history is shorter than the window", () => {
    const ctx = assembleHotContext(warm(), turns(5), { windowSize: 20 });
    expect(ctx.recentDialogue).toHaveLength(5);
  });

  it("defaults to a 20-turn window when not specified", () => {
    const ctx = assembleHotContext(warm(), turns(50));
    expect(ctx.recentDialogue).toHaveLength(20);
  });

  it("rejects negative window sizes", () => {
    expect(() => assembleHotContext(warm(), [], { windowSize: -1 })).toThrow();
  });

  it("is pure — same inputs produce same output", () => {
    const w = warm();
    const t = turns(10);
    const a = assembleHotContext(w, t, { windowSize: 5 });
    const b = assembleHotContext(w, t, { windowSize: 5 });
    expect(a).toEqual(b);
  });
});

describe("formatHotContextAsText", () => {
  it("renders campaign, location, party via dnd5e renderer, NPCs, and dialogue", () => {
    const text = formatHotContextAsText(assembleHotContext(warm(), turns(2)));
    expect(text).toContain("Lost Mine of Phandelver");
    expect(text).toContain("Phandalin Town Square");
    expect(text).toContain("Aragorn");
    expect(text).toContain("HP 22/30");
    expect(text).toContain("Gimli");
    expect(text).toContain("HP 8/28");
    expect(text).toContain("[frightened]");
    expect(text).toContain("Active NPCs (on this scene):");
    expect(text).toContain("Sildar");
    expect(text).toContain("[player] turn 0");
  });

  it("handles empty party / no NPCs / no scene gracefully", () => {
    const text = formatHotContextAsText(
      assembleHotContext(
        {
          campaign: { id: "c", name: "Empty", rulesetId: "dnd5e" },
          party: [],
          activeNpcs: [],
          currentLocation: null,
        },
        [],
      ),
    );
    expect(text).toContain("Current location: (no active scene)");
    expect(text).not.toContain("Party:");
    expect(text).not.toContain("Active NPCs");
    expect(text).not.toContain("Recent dialogue:");
  });
});
