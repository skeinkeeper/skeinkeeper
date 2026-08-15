// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { describe, expect, it } from "vitest";
import { DiscordConsentSurface, SIDE_CHANNEL_MOVED_TEXT } from "./discord_consent_surface.js";

describe("DiscordConsentSurface courtesy reply", () => {
  it("sends the Foundry redirect once per player", async () => {
    const sent: Array<{ id: string; text: string }> = [];
    const surface = new DiscordConsentSurface({
      sendDm: async (id, text) => {
        sent.push({ id, text });
      },
    });
    expect(await surface.handleNonConsentDm("p1")).toBe(true);
    expect(await surface.handleNonConsentDm("p1")).toBe(false);
    expect(await surface.handleNonConsentDm("p2")).toBe(true);
    expect(sent).toEqual([
      { id: "p1", text: SIDE_CHANNEL_MOVED_TEXT },
      { id: "p2", text: SIDE_CHANNEL_MOVED_TEXT },
    ]);
  });
});
