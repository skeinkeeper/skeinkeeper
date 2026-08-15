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

  it("does not treat ordinary chat as a command", () => {
    expect(isSkeinkeeperCommand("I look around the room.")).toBe(false);
    expect(isSkeinkeeperCommand("/emote waves")).toBe(false);
  });
});
