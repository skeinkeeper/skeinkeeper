// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { describe, expect, it } from "vitest";
import { evaluatePrivateAction, pvpEnabledFromSetting } from "./guardrail.js";

describe("evaluatePrivateAction — the two-test guardrail (design doc 0026 §5)", () => {
  it("allows an in-scene action that targets no PC (the common case)", () => {
    expect(
      evaluatePrivateAction(
        { inCurrentScene: true, targetsAnotherPc: false },
        { pvpEnabled: false },
      ),
    ).toEqual({ allow: true });
  });

  it("allows surprise on an NPC even with PvP off", () => {
    // targetsAnotherPc is false for an NPC — "draw and stab the cultist".
    expect(
      evaluatePrivateAction(
        { inCurrentScene: true, targetsAnotherPc: false },
        { pvpEnabled: false },
      ),
    ).toEqual({ allow: true });
  });

  it("denies out-of-scene actions regardless of PvP (the single-scene invariant)", () => {
    const d = evaluatePrivateAction(
      { inCurrentScene: false, targetsAnotherPc: false },
      { pvpEnabled: true },
    );
    expect(d.allow).toBe(false);
    if (!d.allow) {
      expect(d.reason).toBe("out_of_scene");
      expect(d.redirect).toMatch(/split parties|with the group|bring it to the table/i);
    }
  });

  it("geographic test takes precedence over the PvP test", () => {
    // Out-of-scene AND targets a PC with PvP off → the out_of_scene reason wins.
    const d = evaluatePrivateAction(
      { inCurrentScene: false, targetsAnotherPc: true },
      { pvpEnabled: false },
    );
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toBe("out_of_scene");
  });

  it("denies an in-scene PC-targeting action when PvP is off", () => {
    const d = evaluatePrivateAction(
      { inCurrentScene: true, targetsAnotherPc: true },
      { pvpEnabled: false },
    );
    expect(d.allow).toBe(false);
    if (!d.allow) {
      expect(d.reason).toBe("pvp_disabled");
      expect(d.redirect).toMatch(/player-vs-player|pvp/i);
    }
  });

  it("allows an in-scene PC-targeting action when PvP is on", () => {
    expect(
      evaluatePrivateAction({ inCurrentScene: true, targetsAnotherPc: true }, { pvpEnabled: true }),
    ).toEqual({ allow: true });
  });
});

describe("pvpEnabledFromSetting — default OFF (0026 §6)", () => {
  it("is true only for the literal 'true'", () => {
    expect(pvpEnabledFromSetting("true")).toBe(true);
    expect(pvpEnabledFromSetting("false")).toBe(false);
    expect(pvpEnabledFromSetting(undefined)).toBe(false);
    expect(pvpEnabledFromSetting("")).toBe(false);
    expect(pvpEnabledFromSetting("1")).toBe(false);
  });
});
