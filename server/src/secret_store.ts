// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { open, seal, SecretOpenError } from "./secrets.js";

/**
 * Sealed credential store (design doc 0029). Wires the AES-256-GCM seal/open
 * helpers into a sealed config file so provider keys + the bot token live
 * encrypted at rest instead of plaintext .env, opened at boot with one
 * passphrase. The `.env`-only path still works when no sealed file is present.
 */

/** Env-var names eligible for sealing: required for boot + optional-if-present. */
export const SEALABLE_KEYS: readonly string[] = [
  "DISCORD_BOT_TOKEN",
  "ANTHROPIC_API_KEY",
  "DEEPGRAM_API_KEY",
  "ELEVENLABS_API_KEY",
  "SKEINKEEPER_SESSION_SECRET",
  "POSTHOG_PROJECT_API_KEY",
  "SENTRY_DSN",
];

/** Raised when a sealed file exists but cannot be opened (fail closed). */
export class SecretStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretStoreError";
  }
}

/** Where the boot passphrase comes from. The seam for a future keyring source. */
export interface KeySource {
  getPassphrase(): string | undefined;
}

/** Default key source: reads SKEINKEEPER_SECRET_PASSPHRASE from an env map. */
export class EnvKeySource implements KeySource {
  constructor(private readonly env: Record<string, string | undefined> = process.env) {}
  getPassphrase(): string | undefined {
    const v = this.env["SKEINKEEPER_SECRET_PASSPHRASE"];
    return v !== undefined && v.trim().length > 0 ? v : undefined;
  }
}

interface LoadOpts {
  path: string;
  keySource: KeySource;
}

/**
 * Open the sealed file and return the secret map; {} if the file is absent.
 * Fail closed: throws SecretStoreError if the file EXISTS but the passphrase is
 * missing or wrong — never silently ignores a sealed file.
 */
export function loadSealedSecrets(opts: LoadOpts): Record<string, string> {
  if (!existsSync(opts.path)) return {};
  const passphrase = opts.keySource.getPassphrase();
  if (passphrase === undefined) {
    throw new SecretStoreError(
      `Sealed secrets file ${opts.path} exists but no passphrase is available ` +
        `(set SKEINKEEPER_SECRET_PASSPHRASE).`,
    );
  }
  let json: string;
  try {
    json = open(passphrase, readFileSync(opts.path, "utf8").trim());
  } catch (err) {
    if (err instanceof SecretOpenError) {
      throw new SecretStoreError(
        `Could not open sealed secrets file ${opts.path} (wrong passphrase or corrupt data).`,
      );
    }
    throw err;
  }
  return JSON.parse(json) as Record<string, string>;
}

interface SealOpts {
  path: string;
  passphrase: string;
  secrets: Record<string, string>;
}

/** Seal `secrets` under `passphrase` and write the file atomically (mode 0600). */
export function sealSecrets(opts: SealOpts): void {
  const blob = seal(opts.passphrase, JSON.stringify(opts.secrets));
  const tmp = `${opts.path}.tmp`;
  writeFileSync(tmp, blob, { mode: 0o600 });
  renameSync(tmp, opts.path);
  chmodSync(opts.path, 0o600);
}

/** Names of the keys currently sealed (never values); [] if the file is absent. */
export function sealedKeyNames(opts: LoadOpts): string[] {
  return Object.keys(loadSealedSecrets(opts));
}

/**
 * Overlay sealed secrets onto a base env map (sealed wins). Used at boot before
 * loadConfig, so the rest of the app reads secrets from one env map regardless
 * of whether they came from .env or the sealed file.
 */
export function loadEffectiveEnv(
  baseEnv: Record<string, string | undefined>,
  opts: LoadOpts,
): Record<string, string | undefined> {
  return { ...baseEnv, ...loadSealedSecrets(opts) };
}
