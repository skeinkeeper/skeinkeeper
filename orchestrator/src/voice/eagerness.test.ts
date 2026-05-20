// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { describe, expect, it } from "vitest";
import {
  DEFAULT_EAGERNESS,
  eagernessInstruction,
  isEagerness,
  type Eagerness,
} from "./eagerness.js";

describe("isEagerness", () => {
  it("accepts the three valid levels", () => {
    for (const v of ["reserved", "balanced", "eager"]) expect(isEagerness(v)).toBe(true);
  });
  it("rejects anything else (operator-input validation)", () => {
    for (const v of ["", "Balanced", "nonsense", "eagerness"]) expect(isEagerness(v)).toBe(false);
  });
  it("defaults to balanced", () => {
    expect(DEFAULT_EAGERNESS).toBe("balanced");
    expect(isEagerness(DEFAULT_EAGERNESS)).toBe(true);
  });
});

describe("eagernessInstruction", () => {
  const levels: Eagerness[] = ["reserved", "balanced", "eager"];

  it("emits a distinct, level-named instruction for each level", () => {
    const texts = levels.map(eagernessInstruction);
    expect(texts[0]).toContain("RESERVED");
    expect(texts[1]).toContain("BALANCED");
    expect(texts[2]).toContain("EAGER");
    // All three are different.
    expect(new Set(texts).size).toBe(3);
  });

  it("reserved only speaks on direct address or imminent danger", () => {
    const t = eagernessInstruction("reserved");
    expect(t).toMatch(/directly addresses|imminent danger/i);
  });

  it("eager proactively offers color/hints during lulls", () => {
    expect(eagernessInstruction("eager")).toMatch(/color|hint|proactively/i);
  });
});
