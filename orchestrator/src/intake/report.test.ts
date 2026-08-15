// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { describe, expect, it } from "vitest";
import { DM_ONLY_MARKER } from "./summary.js";
import { formatIntakeReportForOperator } from "./report.js";
import type { IntakeFinding } from "./types.js";

const critical: IntakeFinding = {
  id: 1,
  code: "MISSING_RACE_CONTENT",
  kind: "critical-gap",
  summary: 'Required race content for "Fairy" is not loaded.',
  dmOnly: false,
  resolution: {
    prompt: "Proceed anyway?",
    options: [{ id: "proceed-anyway", label: "Proceed anyway" }],
    applyOnResolve: "proceed-anyway",
  },
};

const ambig: IntakeFinding = {
  id: 2,
  code: "AMBIG_STARTING_SCENE",
  kind: "ambiguity",
  summary: "More than one scene could be tonight's starting beat.",
  detail: "Session Start vs Wave Echo Cave",
  dmOnly: true,
  resolution: {
    prompt: "Which scene?",
    options: [
      { id: "s-start", label: "Session Start" },
      { id: "s-cave", label: "Wave Echo Cave" },
    ],
    applyOnResolve: "scene-choice",
  },
};

const reco: IntakeFinding = {
  id: 3,
  code: "RECO_PROPOSED_OWNERSHIP_MAP",
  kind: "recommendation",
  summary: "Proposed character-to-player pairings are ready to confirm.",
  dmOnly: false,
};

describe("formatIntakeReportForOperator", () => {
  it("renders one structured message with Critical / I need a decision / For your info", () => {
    const payload = formatIntakeReportForOperator([critical, ambig, reco]);
    expect(payload.delivery).toBe("notify_operator");
    expect(payload.dmOnly).toBe(true);
    expect(payload.text).toContain("## Critical");
    expect(payload.text).toContain("## I need a decision");
    expect(payload.text).toContain("## For your info");
    expect(payload.text).toContain(critical.summary);
    expect(payload.text).toContain("1. Proceed anyway");
    expect(payload.text).toContain("/skeinkeeper intake resolve 1 proceed-anyway");
    expect(payload.text).toContain(DM_ONLY_MARKER);
    expect(payload.text).toContain("Session Start vs Wave Echo Cave");
    expect(payload.text).toContain(reco.summary);
  });

  it("omits empty sections and does not mark a criticals-only report as dmOnly", () => {
    const payload = formatIntakeReportForOperator([critical]);
    expect(payload.text).toContain("## Critical");
    expect(payload.text).not.toContain("## I need a decision");
    expect(payload.text).not.toContain("## For your info");
    expect(payload.dmOnly).toBe(false);
  });

  it("returns an empty payload when there are no findings", () => {
    const payload = formatIntakeReportForOperator([]);
    expect(payload.text).toBe("");
    expect(payload.findings).toEqual([]);
    expect(payload.dmOnly).toBe(false);
  });

  it("appends an I did the following footer for autonomous actions", () => {
    const payload = formatIntakeReportForOperator([], {
      actions: ["Activated starting scene Goblin Ambush."],
    });
    expect(payload.text).toContain("## I did the following");
    expect(payload.text).toContain("Activated starting scene Goblin Ambush.");
  });
});
