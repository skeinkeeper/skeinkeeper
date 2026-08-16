// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, schema } from "@skeinkeeper/server";
import { DEFAULT_EAGERNESS } from "@skeinkeeper/orchestrator";
import { createApp } from "./bootstrap.js";
import type { AppConfig } from "./config.js";

const dirs: string[] = [];
function makeConfig(): AppConfig {
  const dataDir = mkdtempSync(join(tmpdir(), "sk-boot-"));
  dirs.push(dataDir);
  return {
    dataDir,
    tenantId: "default",
    campaignId: "c1",
    webPort: 3000,
    discord: { botToken: "fake-token", guildId: "fake-guild", voiceChannelId: "fake-vc" },
    anthropicApiKey: "fake-anthropic",
    deepgramApiKey: "fake-deepgram",
    elevenLabsApiKey: "fake-elevenlabs",
    foundry: {
      url: "http://localhost:30000",
      gateway: { bind: "loopback", port: 0, pairingSecret: "test" },
    },
    dmVoiceId: "fake-voice",
    eagerness: DEFAULT_EAGERNESS,
  };
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function withPassphrase<T>(value: string | undefined, fn: () => T): T {
  const prev = process.env.SKEINKEEPER_SECRET_PASSPHRASE;
  if (value === undefined) delete process.env.SKEINKEEPER_SECRET_PASSPHRASE;
  else process.env.SKEINKEEPER_SECRET_PASSPHRASE = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.SKEINKEEPER_SECRET_PASSPHRASE;
    else process.env.SKEINKEEPER_SECRET_PASSPHRASE = prev;
  }
}

describe("createApp — PII encryption wiring (TDD 0030)", () => {
  it("encrypts PII at rest when a passphrase is set", () => {
    const config = makeConfig();
    withPassphrase("build-test-passphrase", () => {
      const app = createApp(config);
      expect(app.tenantDb.piiCrypto.enabled).toBe(true);
      app.consent.grant("discord:42");
      const db = openDb({ path: join(config.dataDir, "skeinkeeper.db") });
      const row = db.select().from(schema.consents).get();
      expect(row?.subjectId.startsWith("gcm:")).toBe(true);
      expect(row?.subjectIdHash).toHaveLength(64);
      // Still readable through the app's tenant-scoped layer (decrypt-on-read).
      expect(app.tenantDb.consents.isGranted("discord:42", "voice_processing")).toBe(true);
      db.close();
    });
  });

  it("leaves PII as plaintext when no passphrase is set (alpha default)", () => {
    const config = makeConfig();
    withPassphrase(undefined, () => {
      const app = createApp(config);
      expect(app.tenantDb.piiCrypto.enabled).toBe(false);
      app.consent.grant("discord:42");
      const db = openDb({ path: join(config.dataDir, "skeinkeeper.db") });
      const row = db.select().from(schema.consents).get();
      expect(row?.subjectId).toBe("discord:42");
      expect(row?.subjectIdHash).toHaveLength(64); // hash companion still populated
      db.close();
    });
  });
});
