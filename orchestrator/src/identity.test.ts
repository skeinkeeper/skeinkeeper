// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { describe, expect, it } from "vitest";
import { resolveCharacterName } from "./identity.js";
import type { FoundryActor } from "./foundry/client.js";

function actor(id: string, name: string): FoundryActor {
  return { id, name, type: "character", system: "dnd5e", sheet: {} };
}

const party: ReadonlyArray<FoundryActor> = [
  actor("a1", "Aragorn, Ranger of the North"),
  actor("a2", "Legolas Greenleaf"),
  actor("a3", "Gimli"),
];

describe("resolveCharacterName", () => {
  it("matches an exact name", () => {
    const res = resolveCharacterName("Gimli", party);
    expect(res.match?.id).toBe("a3");
    expect(res.ambiguous).toBe(false);
  });

  it("matches the first token of a longer actor name", () => {
    const res = resolveCharacterName("Aragorn", party);
    expect(res.match?.id).toBe("a1");
  });

  it("is case- and punctuation-insensitive", () => {
    const res = resolveCharacterName("  legolas!  ", party);
    expect(res.match?.id).toBe("a2");
  });

  it("returns no match when nothing is close", () => {
    const res = resolveCharacterName("Sauron", party);
    expect(res.match).toBeNull();
    expect(res.ambiguous).toBe(false);
    expect(res.candidates).toHaveLength(0);
  });

  it("flags ambiguity when two actors tie", () => {
    const twins: ReadonlyArray<FoundryActor> = [
      actor("t1", "Bran the Elder"),
      actor("t2", "Bran the Younger"),
    ];
    const res = resolveCharacterName("Bran", twins);
    expect(res.match).toBeNull();
    expect(res.ambiguous).toBe(true);
    expect(res.candidates).toHaveLength(2);
  });
});
