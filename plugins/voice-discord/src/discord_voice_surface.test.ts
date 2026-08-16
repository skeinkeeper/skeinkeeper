// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { describe, expect, it } from "vitest";
import { FakeVoiceIO } from "@skeinkeeper/orchestrator";
import { DiscordVoiceSurface } from "./discord_voice_surface.js";

describe("DiscordVoiceSurface", () => {
  it("speaks table-audience text through VoiceIO", async () => {
    const voice = new FakeVoiceIO([]);
    const surface = new DiscordVoiceSurface(voice);
    await surface.emit({ audience: { kind: "table" }, text: "The door creaks." });
    expect(voice.spoken).toEqual([{ text: "The door creaks.", opts: undefined }]);
  });
});
