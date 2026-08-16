// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { DEFAULT_EAGERNESS, isEagerness, type Eagerness } from "@skeinkeeper/orchestrator";

/**
 * Operator app configuration (design doc 0020). Loaded from the environment —
 * either plaintext .env or, when present, the sealed secret store opened at boot
 * and overlaid before loadConfig (design doc 0029).
 * Pure + testable: `loadConfig` takes an env map and returns a validated config or
 * throws a ConfigError listing everything missing.
 */
export interface AppConfig {
  dataDir: string;
  tenantId: string;
  campaignId: string;
  webPort: number;
  discord: {
    botToken: string;
    guildId: string;
    voiceChannelId: string;
    /** Operator's Discord user ID — the AI DMs them setup escalations here
     *  (design doc 0023). Optional; without it, escalations fall back to logs. */
    operatorUserId?: string;
  };
  anthropicApiKey: string;
  /** Optional model overrides (ANTHROPIC_MODEL_NARRATION / _ORCHESTRATION);
   *  the provider's per-tier defaults apply when unset. */
  anthropicModelNarration?: string;
  anthropicModelOrchestration?: string;
  deepgramApiKey: string;
  elevenLabsApiKey: string;
  foundry: {
    url: string;
    gateway: {
      bind: "loopback" | "lan";
      port: number;
      pairingSecret: string;
      tls?: { cert: string; key: string };
    };
  };
  /** Curated DM persona's provider voice ID (the operator picks a persona; the
   *  app resolves it to this). */
  dmVoiceId: string;
  /** Default "should I respond?" calibration; runtime-tunable via the UI. */
  eagerness: Eagerness;
}

export class ConfigError extends Error {
  constructor(public readonly missing: ReadonlyArray<string>) {
    super(`Missing or invalid config: ${missing.join(", ")}`);
    this.name = "ConfigError";
  }
}

type Env = Record<string, string | undefined>;

function req(env: Env, key: string, missing: string[]): string {
  const v = env[key];
  if (v === undefined || v.trim() === "") {
    missing.push(key);
    return "";
  }
  return v;
}

/** Parse a port env value, falling back to the default on missing/non-numeric
 *  input (a bare `Number("abc")` is NaN, which `listen(NaN)` silently treats as
 *  a random port). */
function parsePort(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n >= 0 && n <= 65535 ? n : fallback;
}

const DEFAULT_DM_VOICE_ID = "JBFqnCBsd6RMkjVDRZzb"; // George — warm storyteller

function gatewayFromEnv(env: Env, missing: string[]): AppConfig["foundry"]["gateway"] {
  const bindRaw = (env["FOUNDRY_GATEWAY_BIND"] ?? "loopback").trim();
  const bind = bindRaw === "lan" ? "lan" : "loopback";
  const secret = (env["FOUNDRY_PAIRING_SECRET"] ?? "").trim();
  const cert = env["FOUNDRY_GATEWAY_TLS_CERT"];
  const key = env["FOUNDRY_GATEWAY_TLS_KEY"];
  const tls =
    cert !== undefined && cert.length > 0 && key !== undefined && key.length > 0
      ? { cert, key }
      : undefined;
  if (bind === "lan") {
    if (secret.length === 0 || tls === undefined) {
      missing.push("FOUNDRY_GATEWAY_TLS_CERT+FOUNDRY_GATEWAY_TLS_KEY+FOUNDRY_PAIRING_SECRET");
    }
  }
  return {
    bind,
    port: parsePort(env["FOUNDRY_GATEWAY_PORT"], 7733),
    pairingSecret: secret,
    ...(tls !== undefined ? { tls } : {}),
  };
}

export function loadConfig(env: Env): AppConfig {
  const missing: string[] = [];
  const config: AppConfig = {
    dataDir: env["SKEINKEEPER_DATA_DIR"] ?? "./data",
    tenantId: env["SKEINKEEPER_TENANT_ID"] ?? "default",
    campaignId: env["SKEINKEEPER_CAMPAIGN_ID"] ?? "default",
    webPort: parsePort(env["SKEINKEEPER_WEB_PORT"], 3000),
    discord: {
      botToken: req(env, "DISCORD_BOT_TOKEN", missing),
      guildId: req(env, "DISCORD_GUILD_ID", missing),
      voiceChannelId: req(env, "DISCORD_VOICE_CHANNEL_ID", missing),
      ...(env["DISCORD_OPERATOR_USER_ID"] && env["DISCORD_OPERATOR_USER_ID"].trim().length > 0
        ? { operatorUserId: env["DISCORD_OPERATOR_USER_ID"].trim() }
        : {}),
    },
    anthropicApiKey: req(env, "ANTHROPIC_API_KEY", missing),
    ...(env["ANTHROPIC_MODEL_NARRATION"] && env["ANTHROPIC_MODEL_NARRATION"].trim().length > 0
      ? { anthropicModelNarration: env["ANTHROPIC_MODEL_NARRATION"].trim() }
      : {}),
    ...(env["ANTHROPIC_MODEL_ORCHESTRATION"] &&
    env["ANTHROPIC_MODEL_ORCHESTRATION"].trim().length > 0
      ? { anthropicModelOrchestration: env["ANTHROPIC_MODEL_ORCHESTRATION"].trim() }
      : {}),
    deepgramApiKey: req(env, "DEEPGRAM_API_KEY", missing),
    elevenLabsApiKey: req(env, "ELEVENLABS_API_KEY", missing),
    foundry: {
      url: env["FOUNDRY_URL"] ?? "http://localhost:30000",
      gateway: gatewayFromEnv(env, missing),
    },
    dmVoiceId: env["ELEVENLABS_DM_VOICE_ID"] ?? DEFAULT_DM_VOICE_ID,
    eagerness: isEagerness(env["SKEINKEEPER_EAGERNESS"] ?? "")
      ? (env["SKEINKEEPER_EAGERNESS"] as Eagerness)
      : DEFAULT_EAGERNESS,
  };
  if (missing.length > 0) throw new ConfigError(missing);
  return config;
}
