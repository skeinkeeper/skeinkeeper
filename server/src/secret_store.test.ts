// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EnvKeySource,
  SEALABLE_KEYS,
  SecretStoreError,
  loadEffectiveEnv,
  loadSealedSecrets,
  sealSecrets,
  sealedKeyNames,
} from "./secret_store.js";

describe("secret_store", () => {
  let dir: string;
  let path: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sk-secrets-"));
    path = join(dir, "secrets.sealed");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const src = (pass?: string): EnvKeySource =>
    new EnvKeySource(pass === undefined ? {} : { SKEINKEEPER_SECRET_PASSPHRASE: pass });

  it("round-trips sealed secrets with the right passphrase", () => {
    sealSecrets({
      path,
      passphrase: "pw",
      secrets: { ANTHROPIC_API_KEY: "sk-ant-x", DISCORD_BOT_TOKEN: "tok" },
    });
    expect(loadSealedSecrets({ path, keySource: src("pw") })).toEqual({
      ANTHROPIC_API_KEY: "sk-ant-x",
      DISCORD_BOT_TOKEN: "tok",
    });
  });

  it("returns {} when no sealed file exists", () => {
    expect(loadSealedSecrets({ path, keySource: src("pw") })).toEqual({});
  });

  it("throws SecretStoreError when the file exists but no passphrase is available (fail closed)", () => {
    sealSecrets({ path, passphrase: "pw", secrets: { ANTHROPIC_API_KEY: "x" } });
    expect(() => loadSealedSecrets({ path, keySource: src(undefined) })).toThrow(SecretStoreError);
  });

  it("throws SecretStoreError on a wrong passphrase", () => {
    sealSecrets({ path, passphrase: "right", secrets: { ANTHROPIC_API_KEY: "x" } });
    expect(() => loadSealedSecrets({ path, keySource: src("wrong") })).toThrow(SecretStoreError);
  });

  it("writes the sealed file with 0600 permissions and no plaintext", () => {
    sealSecrets({ path, passphrase: "pw", secrets: { ANTHROPIC_API_KEY: "sk-ant-secret" } });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf8")).not.toContain("sk-ant-secret");
  });

  it("lists sealed key names without values; [] when no file", () => {
    expect(sealedKeyNames({ path, keySource: src("pw") })).toEqual([]);
    sealSecrets({
      path,
      passphrase: "pw",
      secrets: { DISCORD_BOT_TOKEN: "tok", ANTHROPIC_API_KEY: "k" },
    });
    expect(sealedKeyNames({ path, keySource: src("pw") }).sort()).toEqual([
      "ANTHROPIC_API_KEY",
      "DISCORD_BOT_TOKEN",
    ]);
  });

  it("EnvKeySource reads SKEINKEEPER_SECRET_PASSPHRASE", () => {
    expect(new EnvKeySource({ SKEINKEEPER_SECRET_PASSPHRASE: "pw" }).getPassphrase()).toBe("pw");
    expect(new EnvKeySource({}).getPassphrase()).toBeUndefined();
  });

  it("loadEffectiveEnv overlays sealed secrets onto the base env (sealed wins)", () => {
    sealSecrets({ path, passphrase: "pw", secrets: { ANTHROPIC_API_KEY: "sealed-key" } });
    const eff = loadEffectiveEnv(
      { ANTHROPIC_API_KEY: "env-key", DISCORD_GUILD_ID: "g1" },
      { path, keySource: src("pw") },
    );
    expect(eff.ANTHROPIC_API_KEY).toBe("sealed-key");
    expect(eff.DISCORD_GUILD_ID).toBe("g1");
  });

  it("loadEffectiveEnv passes the base env through unchanged when no sealed file", () => {
    const base = { ANTHROPIC_API_KEY: "env-key" };
    expect(loadEffectiveEnv(base, { path, keySource: src("pw") })).toEqual(base);
  });

  it("SEALABLE_KEYS covers the required secrets", () => {
    for (const k of [
      "DISCORD_BOT_TOKEN",
      "ANTHROPIC_API_KEY",
      "DEEPGRAM_API_KEY",
      "ELEVENLABS_API_KEY",
    ]) {
      expect(SEALABLE_KEYS).toContain(k);
    }
  });
});
