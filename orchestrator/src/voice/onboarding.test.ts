// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { describe, expect, it } from "vitest";
import type { PresenceMember } from "../interfaces/voice.js";
import { buildOnboardingDirective, selectOnboardingTargets } from "./onboarding.js";

const m = (id: string, displayName?: string): PresenceMember =>
  displayName !== undefined ? { id, displayName } : { id };

/** All present members consented, unless overridden. */
const allConsented = (...ids: string[]): Set<string> => new Set(ids);

describe("selectOnboardingTargets", () => {
  it("returns nobody for an empty channel", () => {
    expect(
      selectOnboardingTargets({
        present: [],
        consented: new Set(),
        mapped: new Set(),
        greeted: new Set(),
      }),
    ).toEqual([]);
  });

  it("returns present, consented members who are neither mapped nor greeted", () => {
    const targets = selectOnboardingTargets({
      present: [m("d:alice", "Alice"), m("d:bob", "Bob"), m("d:carol", "Carol")],
      consented: allConsented("d:alice", "d:bob", "d:carol"),
      mapped: new Set(["d:bob"]),
      greeted: new Set(["d:carol"]),
    });
    expect(targets.map((t) => t.id)).toEqual(["d:alice"]);
  });

  it("excludes members who have not consented", () => {
    const targets = selectOnboardingTargets({
      present: [m("d:alice", "Alice"), m("d:bob", "Bob")],
      consented: allConsented("d:alice"),
      mapped: new Set(),
      greeted: new Set(),
    });
    expect(targets.map((t) => t.id)).toEqual(["d:alice"]);
  });

  it("preserves join order", () => {
    const targets = selectOnboardingTargets({
      present: [m("d:bob", "Bob"), m("d:alice", "Alice")],
      consented: allConsented("d:alice", "d:bob"),
      mapped: new Set(),
      greeted: new Set(),
    });
    expect(targets.map((t) => t.id)).toEqual(["d:bob", "d:alice"]);
  });

  it("excludes a member once they are both mapped and greeted", () => {
    const targets = selectOnboardingTargets({
      present: [m("d:alice", "Alice")],
      consented: allConsented("d:alice"),
      mapped: new Set(["d:alice"]),
      greeted: new Set(["d:alice"]),
    });
    expect(targets).toEqual([]);
  });
});

describe("buildOnboardingDirective", () => {
  it("phrases a single newcomer as a personal welcome", () => {
    const text = buildOnboardingDirective([m("d:alice", "Alice")]);
    expect(text).toContain("Alice");
    expect(text).toContain("Welcome");
    expect(text).not.toContain("go around");
  });

  it("phrases multiple newcomers as a group greeting with go-around", () => {
    const text = buildOnboardingDirective([m("d:alice", "Alice"), m("d:bob", "Bob")]);
    expect(text).toContain("Alice, Bob");
    expect(text).toContain("go around");
  });

  it("falls back to the id when no display name is present", () => {
    const text = buildOnboardingDirective([m("d:alice")]);
    expect(text).toContain("d:alice");
  });
});
