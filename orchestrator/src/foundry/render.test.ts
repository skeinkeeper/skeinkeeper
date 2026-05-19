// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { describe, expect, it } from "vitest";
import { renderActorState } from "./render.js";
import type { FoundryActor } from "./client.js";

describe("renderActorState — dnd5e", () => {
  it("renders HP, AC, and active conditions", () => {
    const actor: FoundryActor = {
      id: "a",
      name: "Aragorn",
      type: "character",
      system: "dnd5e",
      sheet: {
        attributes: { hp: { value: 22, max: 30 }, ac: { value: 18 } },
        conditions: ["frightened"],
      },
    };
    const out = renderActorState(actor);
    expect(out).toContain("Aragorn");
    expect(out).toContain("HP 22/30");
    expect(out).toContain("AC 18");
    expect(out).toContain("[frightened]");
  });

  it("omits missing fields", () => {
    const actor: FoundryActor = {
      id: "a",
      name: "Gimli",
      type: "character",
      system: "dnd5e",
      sheet: { attributes: { hp: { value: 8, max: 28 } } },
    };
    const out = renderActorState(actor);
    expect(out).toContain("HP 8/28");
    expect(out).not.toContain("AC");
    expect(out).not.toContain("[");
  });
});

describe("renderActorState — fate-core", () => {
  it("renders stress tracks, consequences, and aspects", () => {
    const actor: FoundryActor = {
      id: "a",
      name: "Aragorn",
      type: "character",
      system: "fate-core",
      sheet: {
        stress: { physical: [true, false], mental: [false, false] },
        consequences: [
          { severity: "mild", text: "Shaken by what I saw" },
          { severity: "moderate", text: "" },
        ],
        aspects: [{ text: "Heir of Isildur" }, { text: "Bonded to Andúril" }],
      },
    };
    const out = renderActorState(actor);
    expect(out).toContain("Aragorn");
    expect(out).toContain("physical 1/2");
    expect(out).toContain("mental 0/2");
    expect(out).toContain('mild: "Shaken by what I saw"');
    expect(out).toContain('"Heir of Isildur"');
  });
});

describe("renderActorState — dungeon-world", () => {
  it("renders HP, armor, and debilities", () => {
    const actor: FoundryActor = {
      id: "a",
      name: "Strider",
      type: "character",
      system: "dungeon-world",
      sheet: {
        attributes: { hp: { value: 18, max: 22 }, armor: { value: 1 } },
        debilities: { weak: true, shaky: false, sick: false },
      },
    };
    const out = renderActorState(actor);
    expect(out).toContain("Strider");
    expect(out).toContain("HP 18/22");
    expect(out).toContain("armor 1");
    expect(out).toContain("debilities: weak");
  });
});

describe("renderActorState — generic fallback", () => {
  it("picks up common health-ish fields if present", () => {
    const actor: FoundryActor = {
      id: "a",
      name: "Mystery Adventurer",
      type: "character",
      system: "homebrew-system",
      sheet: { hp: { value: 5, max: 10 } },
    };
    const out = renderActorState(actor);
    expect(out).toContain("Mystery Adventurer");
    expect(out).toContain("hp 5/10");
  });

  it("falls back to a 'no rendered state' note when nothing recognized", () => {
    const actor: FoundryActor = {
      id: "a",
      name: "Stranger",
      type: "npc",
      system: "homebrew-system",
      sheet: { someField: 42 },
    };
    const out = renderActorState(actor);
    expect(out).toContain("Stranger");
    expect(out).toContain("homebrew-system");
    expect(out).toContain("no rendered state");
  });
});
