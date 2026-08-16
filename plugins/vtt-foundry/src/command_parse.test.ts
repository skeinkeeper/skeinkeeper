// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { describe, expect, it } from "vitest";
import { isSkeinkeeperCommand, parseSkeinkeeperCommand } from "./command_parse.js";

describe("parseSkeinkeeperCommand", () => {
  it("parses eagerness level:high", () => {
    const r = parseSkeinkeeperCommand("/skeinkeeper eagerness level:high");
    expect(r).toMatchObject({
      ok: true,
      verb: "eagerness",
      args: ["level:high"],
      raw: "/skeinkeeper eagerness level:high",
    });
    if (r.ok) expect(r.control).toEqual({ control: "eagerness", level: "high" });
  });

  it("rejects an unknown verb", () => {
    const r = parseSkeinkeeperCommand("/skeinkeeper foo bar baz");
    expect(r.ok).toBe(false);
    expect(r.verb).toBe("foo");
    expect(r.args).toEqual(["bar", "baz"]);
  });

  it("parses preflight verify and preflight verify @player", () => {
    const all = parseSkeinkeeperCommand("/skeinkeeper preflight verify");
    expect(all.ok).toBe(true);
    if (all.ok) expect(all.control).toEqual({ control: "preflight" });
    const one = parseSkeinkeeperCommand("/skeinkeeper preflight verify @d1");
    expect(one.ok).toBe(true);
    if (one.ok) expect(one.control).toEqual({ control: "preflight", player: "d1" });
  });

  it("does not treat ordinary chat as a command", () => {
    expect(isSkeinkeeperCommand("I look around the room.")).toBe(false);
    expect(isSkeinkeeperCommand("/emote waves")).toBe(false);
  });
});

describe("operator dm-consent (design doc 0039 pause-notification opt-in)", () => {
  it("parses /skeinkeeper operator dm-consent on", () => {
    const r = parseSkeinkeeperCommand("/skeinkeeper operator dm-consent on");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.control).toEqual({ control: "operator-dm-consent", enabled: true });
  });

  it("parses /skeinkeeper operator dm-consent off", () => {
    const r = parseSkeinkeeperCommand("/skeinkeeper operator dm-consent off");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.control).toEqual({ control: "operator-dm-consent", enabled: false });
  });

  it("rejects a missing on/off argument", () => {
    const r = parseSkeinkeeperCommand("/skeinkeeper operator dm-consent");
    expect(r.ok).toBe(false);
  });
});
