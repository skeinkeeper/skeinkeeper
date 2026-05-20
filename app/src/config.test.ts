// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { describe, expect, it } from "vitest";
import { loadConfig, ConfigError } from "./config.js";

const FULL = {
  DISCORD_BOT_TOKEN: "tok",
  DISCORD_GUILD_ID: "g1",
  DISCORD_VOICE_CHANNEL_ID: "c1",
  ANTHROPIC_API_KEY: "a",
  DEEPGRAM_API_KEY: "d",
  ELEVENLABS_API_KEY: "e",
};

describe("loadConfig", () => {
  it("parses a complete env with sensible defaults", () => {
    const cfg = loadConfig(FULL);
    expect(cfg.discord.guildId).toBe("g1");
    expect(cfg.dataDir).toBe("./data");
    expect(cfg.webPort).toBe(3000);
    expect(cfg.eagerness).toBe("balanced");
    expect(cfg.foundry.mcpPort).toBe(31415);
  });

  it("throws ConfigError listing every missing required key", () => {
    try {
      loadConfig({ DISCORD_BOT_TOKEN: "tok" });
      throw new Error("expected ConfigError");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const missing = (err as ConfigError).missing;
      expect(missing).toContain("DISCORD_GUILD_ID");
      expect(missing).toContain("ANTHROPIC_API_KEY");
      expect(missing).not.toContain("DISCORD_BOT_TOKEN");
    }
  });

  it("reads the optional operator user id, omitting it when blank", () => {
    expect(loadConfig(FULL).discord.operatorUserId).toBeUndefined();
    const withOp = loadConfig({ ...FULL, DISCORD_OPERATOR_USER_ID: "  op-123  " });
    expect(withOp.discord.operatorUserId).toBe("op-123");
    const blank = loadConfig({ ...FULL, DISCORD_OPERATOR_USER_ID: "   " });
    expect(blank.discord.operatorUserId).toBeUndefined();
  });

  it("falls back to the default port on a non-numeric value (no NaN)", () => {
    expect(loadConfig({ ...FULL, SKEINKEEPER_WEB_PORT: "not-a-port" }).webPort).toBe(3000);
    expect(loadConfig({ ...FULL, FOUNDRY_MCP_PORT: "abc" }).foundry.mcpPort).toBe(31415);
    expect(loadConfig({ ...FULL, SKEINKEEPER_WEB_PORT: "70000" }).webPort).toBe(3000); // out of range
  });

  it("honors overrides and falls back to balanced on an invalid eagerness", () => {
    const cfg = loadConfig({ ...FULL, SKEINKEEPER_WEB_PORT: "8080", SKEINKEEPER_EAGERNESS: "nonsense" });
    expect(cfg.webPort).toBe(8080);
    expect(cfg.eagerness).toBe("balanced");
    const eager = loadConfig({ ...FULL, SKEINKEEPER_EAGERNESS: "eager" });
    expect(eager.eagerness).toBe("eager");
  });
});
