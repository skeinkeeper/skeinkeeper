// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { describe, expect, it } from "vitest";
import { allowedAudiencesFor, audienceVisibleInConversation } from "./audience.js";

describe("allowedAudiencesFor (the structural anti-leak guarantee, design doc 0026 §10)", () => {
  it("the table loop sees shared + gm, never any player-private", () => {
    expect(allowedAudiencesFor("table").sort()).toEqual(["gm", "table"]);
  });

  it("a player side-channel sees shared + that player's own — never gm, never another player", () => {
    expect(allowedAudiencesFor("player:discord:1").sort()).toEqual(["player:discord:1", "table"]);
  });

  it("excludes gm secrets from a player's context", () => {
    expect(audienceVisibleInConversation("gm", "player:discord:1")).toBe(false);
  });

  it("excludes another player's private content from a player's context", () => {
    expect(audienceVisibleInConversation("player:discord:2", "player:discord:1")).toBe(false);
  });

  it("a player can see shared table content and their own private content", () => {
    expect(audienceVisibleInConversation("table", "player:discord:1")).toBe(true);
    expect(audienceVisibleInConversation("player:discord:1", "player:discord:1")).toBe(true);
  });

  it("the table loop cannot see any player's private content", () => {
    expect(audienceVisibleInConversation("player:discord:1", "table")).toBe(false);
    expect(audienceVisibleInConversation("gm", "table")).toBe(true);
  });
});
