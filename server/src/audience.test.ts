// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { describe, expect, it } from "vitest";
import {
  GM_AUDIENCE,
  TABLE_AUDIENCE,
  TABLE_CONVERSATION,
  isPlayerScoped,
  playerAudience,
  playerConversation,
  playerIdOf,
} from "./audience.js";

describe("audience vocabulary (design doc 0026, ADR-0017)", () => {
  it("builds player-scoped audience + conversation ids from a Discord id", () => {
    expect(playerAudience("discord:42")).toBe("player:discord:42");
    expect(playerConversation("discord:42")).toBe("player:discord:42");
  });

  it("recognizes player-scoped values, rejects table/gm and the bare prefix", () => {
    expect(isPlayerScoped("player:discord:42")).toBe(true);
    expect(isPlayerScoped(TABLE_AUDIENCE)).toBe(false);
    expect(isPlayerScoped(GM_AUDIENCE)).toBe(false);
    expect(isPlayerScoped(TABLE_CONVERSATION)).toBe(false);
    // bare prefix with no id is not a valid player scope
    expect(isPlayerScoped("player:")).toBe(false);
  });

  it("extracts the embedded Discord id, or null for non-player scopes", () => {
    expect(playerIdOf("player:discord:42")).toBe("discord:42");
    expect(playerIdOf(TABLE_AUDIENCE)).toBeNull();
    expect(playerIdOf(GM_AUDIENCE)).toBeNull();
    expect(playerIdOf("player:")).toBeNull();
  });

  it("round-trips id → audience → id", () => {
    const id = "discord:abc123";
    expect(playerIdOf(playerAudience(id))).toBe(id);
  });
});
