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
    expect(cfg.foundry.gateway.port).toBe(7733);
    expect(cfg.foundry.gateway.bind).toBe("loopback");
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

  it("reads optional Anthropic model overrides, omitting them when blank", () => {
    expect(loadConfig(FULL).anthropicModelNarration).toBeUndefined();
    expect(loadConfig(FULL).anthropicModelOrchestration).toBeUndefined();
    const over = loadConfig({
      ...FULL,
      ANTHROPIC_MODEL_NARRATION: "  claude-x  ",
      ANTHROPIC_MODEL_ORCHESTRATION: "claude-y",
    });
    expect(over.anthropicModelNarration).toBe("claude-x");
    expect(over.anthropicModelOrchestration).toBe("claude-y");
    expect(
      loadConfig({ ...FULL, ANTHROPIC_MODEL_NARRATION: "   " }).anthropicModelNarration,
    ).toBeUndefined();
  });

  it("falls back to the default port on a non-numeric value (no NaN)", () => {
    expect(loadConfig({ ...FULL, SKEINKEEPER_WEB_PORT: "not-a-port" }).webPort).toBe(3000);
    expect(loadConfig({ ...FULL, FOUNDRY_GATEWAY_PORT: "abc" }).foundry.gateway.port).toBe(7733);
    expect(loadConfig({ ...FULL, SKEINKEEPER_WEB_PORT: "70000" }).webPort).toBe(3000); // out of range
  });

  it("honors overrides and falls back to balanced on an invalid eagerness", () => {
    const cfg = loadConfig({
      ...FULL,
      SKEINKEEPER_WEB_PORT: "8080",
      SKEINKEEPER_EAGERNESS: "nonsense",
    });
    expect(cfg.webPort).toBe(8080);
    expect(cfg.eagerness).toBe("balanced");
    const eager = loadConfig({ ...FULL, SKEINKEEPER_EAGERNESS: "eager" });
    expect(eager.eagerness).toBe("eager");
  });

  it("refuses lan bind without TLS and a pairing secret", () => {
    expect(() => loadConfig({ ...FULL, FOUNDRY_GATEWAY_BIND: "lan" })).toThrow(ConfigError);
  });

  it("accepts container bind with no pairing secret and no TLS (TDD 0043)", () => {
    // The secret is generated and persisted at boot (loadOrCreatePairingSecret),
    // so requiring it in the env would put a setup step in front of
    // `docker compose up`. TLS is not required: the bind is inside the
    // container's network namespace, published to host loopback only.
    const cfg = loadConfig({ ...FULL, FOUNDRY_GATEWAY_BIND: "container" });
    expect(cfg.foundry.gateway.bind).toBe("container");
    expect(cfg.foundry.gateway.pairingSecret).toBe("");
    expect(cfg.foundry.gateway.tls).toBeUndefined();
  });

  it("keeps an operator-set secret and TLS in container mode", () => {
    const cfg = loadConfig({
      ...FULL,
      FOUNDRY_GATEWAY_BIND: "container",
      FOUNDRY_PAIRING_SECRET: "  fake-secret  ",
      FOUNDRY_GATEWAY_TLS_CERT: "fake-cert",
      FOUNDRY_GATEWAY_TLS_KEY: "fake-key",
    });
    expect(cfg.foundry.gateway.pairingSecret).toBe("fake-secret");
    expect(cfg.foundry.gateway.tls).toEqual({ cert: "fake-cert", key: "fake-key" });
  });

  it("falls back to loopback on an unrecognised bind value", () => {
    // Matches the rest of the parser: unknown input degrades to the safe
    // default rather than binding something wide by accident.
    expect(loadConfig({ ...FULL, FOUNDRY_GATEWAY_BIND: "nonsense" }).foundry.gateway.bind).toBe(
      "loopback",
    );
    expect(loadConfig({ ...FULL, FOUNDRY_GATEWAY_BIND: "" }).foundry.gateway.bind).toBe("loopback");
    expect(
      loadConfig({ ...FULL, FOUNDRY_GATEWAY_BIND: "  container  " }).foundry.gateway.bind,
    ).toBe("container");
  });
});
