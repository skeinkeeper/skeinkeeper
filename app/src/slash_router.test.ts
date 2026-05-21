// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { describe, expect, it } from "vitest";
import { consentButtonIntent, parseSlashCommand, type SlashInput } from "./slash_router.js";

const input = (over: Partial<SlashInput>): SlashInput => ({
  sub: null,
  action: null,
  level: null,
  persona: null,
  ...over,
});

describe("parseSlashCommand", () => {
  it("routes operator to the (gated) operator handler, passing the action through", () => {
    expect(parseSlashCommand(input({ sub: "operator", action: "claim" }))).toEqual({
      kind: "operator",
      action: "claim",
    });
  });

  it("routes session stop, and blocks start", () => {
    expect(parseSlashCommand(input({ sub: "session", action: "stop" })).kind).toBe("session.stop");
    expect(parseSlashCommand(input({ sub: "session", action: "start" })).kind).toBe(
      "session.start_blocked",
    );
  });

  it("validates eagerness level, falling back to usage", () => {
    expect(parseSlashCommand(input({ sub: "eagerness", level: "eager" }))).toEqual({
      kind: "eagerness.set",
      level: "eager",
    });
    expect(parseSlashCommand(input({ sub: "eagerness", level: "nonsense" })).kind).toBe(
      "eagerness.usage",
    );
    expect(parseSlashCommand(input({ sub: "eagerness", level: null })).kind).toBe(
      "eagerness.usage",
    );
  });

  it("routes voice list / set, and flags a missing persona", () => {
    expect(parseSlashCommand(input({ sub: "voice", action: "list" })).kind).toBe("voice.list");
    expect(parseSlashCommand(input({ sub: "voice", action: "set", persona: "warm" }))).toEqual({
      kind: "voice.set",
      personaId: "warm",
    });
    expect(parseSlashCommand(input({ sub: "voice", action: "set", persona: null })).kind).toBe(
      "voice.set_missing",
    );
    expect(parseSlashCommand(input({ sub: "voice", action: "bogus" })).kind).toBe("voice.usage");
  });

  it("routes the pvp toggle (on/off/show), falling back to usage", () => {
    expect(parseSlashCommand(input({ sub: "pvp", action: "on" }))).toEqual({
      kind: "pvp.set",
      enabled: true,
    });
    expect(parseSlashCommand(input({ sub: "pvp", action: "off" }))).toEqual({
      kind: "pvp.set",
      enabled: false,
    });
    expect(parseSlashCommand(input({ sub: "pvp", action: "show" })).kind).toBe("pvp.show");
    expect(parseSlashCommand(input({ sub: "pvp", action: "bogus" })).kind).toBe("pvp.usage");
  });

  it("defaults to consent for the consent subcommand and unknown subs", () => {
    expect(parseSlashCommand(input({ sub: "consent", action: "grant" })).kind).toBe(
      "consent.grant",
    );
    expect(parseSlashCommand(input({ sub: "consent", action: "withdraw" })).kind).toBe(
      "consent.withdraw",
    );
    expect(parseSlashCommand(input({ sub: "consent", action: "huh" })).kind).toBe("consent.usage");
    expect(parseSlashCommand(input({ sub: null, action: null })).kind).toBe("consent.usage");
  });
});

describe("consentButtonIntent", () => {
  it("maps the consent DM button ids", () => {
    expect(consentButtonIntent("sk-consent-grant")).toBe("grant");
    expect(consentButtonIntent("sk-consent-withdraw")).toBe("withdraw");
    expect(consentButtonIntent("something-else")).toBeNull();
  });
});
