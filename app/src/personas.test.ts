// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { describe, expect, it } from "vitest";
import { dmPersonas, resolveDmPersonaVoice, defaultDmPersonaVoice } from "./personas.js";

describe("DM personas", () => {
  it("every curated persona maps to a provider voice id", () => {
    const personas = dmPersonas();
    expect(personas.length).toBeGreaterThan(0);
    for (const p of personas) {
      expect(resolveDmPersonaVoice(p.id)).toBeTruthy();
    }
  });

  it("resolves the default persona voice and rejects unknowns", () => {
    expect(defaultDmPersonaVoice()).toBeTruthy();
    expect(resolveDmPersonaVoice("does-not-exist")).toBeUndefined();
  });
});
