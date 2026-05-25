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
import { createPiiCrypto } from "./column_crypto.js";

const SALT = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const crypto = createPiiCrypto({ keySource: { getPassphrase: () => undefined }, salt: SALT });

describe("audience vocabulary (design doc 0026, ADR-0017, TDD 0030)", () => {
  it("embeds the HASH of the Discord id, never the raw id", () => {
    const expected = `player:${crypto.hash("discord:42")}`;
    expect(playerAudience(crypto, "discord:42")).toBe(expected);
    expect(playerConversation(crypto, "discord:42")).toBe(expected);
    // The routing token must not carry the recoverable Discord id.
    expect(playerAudience(crypto, "discord:42")).not.toContain("discord:42");
  });

  it("recognizes player-scoped values, rejects table/gm and the bare prefix", () => {
    expect(isPlayerScoped(playerAudience(crypto, "discord:42"))).toBe(true);
    expect(isPlayerScoped(TABLE_AUDIENCE)).toBe(false);
    expect(isPlayerScoped(GM_AUDIENCE)).toBe(false);
    expect(isPlayerScoped(TABLE_CONVERSATION)).toBe(false);
    // bare prefix with no id is not a valid player scope
    expect(isPlayerScoped("player:")).toBe(false);
  });

  it("extracts the embedded hash from a player token, or null for non-player scopes", () => {
    expect(playerIdOf(playerAudience(crypto, "discord:42"))).toBe(crypto.hash("discord:42"));
    expect(playerIdOf(TABLE_AUDIENCE)).toBeNull();
    expect(playerIdOf(GM_AUDIENCE)).toBeNull();
    expect(playerIdOf("player:")).toBeNull();
  });

  it("round-trips id → audience → embedded hash", () => {
    const id = "discord:abc123";
    expect(playerIdOf(playerAudience(crypto, id))).toBe(crypto.hash(id));
  });
});
