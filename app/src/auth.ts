// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Local operator auth (design doc 0020 §6, CLAUDE.md: local password + optional
 * passkey, no remote auth). Password hashing via scrypt and a signed session
 * token via HMAC — Node crypto only, no dependencies, fully testable. WebAuthn
 * passkeys are a later add; this is the password path.
 */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const salt = Buffer.from(parts[1]!, "hex");
  const expected = Buffer.from(parts[2]!, "hex");
  const actual = scryptSync(password, salt, expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function mintToken(secret: string, subject: string, expiresAtMs: number): string {
  const payload = Buffer.from(JSON.stringify({ sub: subject, exp: expiresAtMs })).toString(
    "base64url",
  );
  const sig = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

export function verifyToken(secret: string, token: string, now: number = Date.now()): boolean {
  const dot = token.indexOf(".");
  if (dot < 0) return false;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = createHmac("sha256", secret).update(payload).digest("base64url");
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) return false;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      exp?: unknown;
    };
    return typeof claims.exp === "number" && now < claims.exp;
  } catch {
    return false;
  }
}

/** Where a generated console password is persisted, under the data dir. */
export const CONSOLE_PASSWORD_FILE = ".console-password";

export interface ConsoleCredential {
  /** Plaintext. Show it to the operator ONLY when `created` — see below. */
  password: string;
  /** `hashPassword` digest, for the web server's `auth.passwordHash`. */
  hash: string;
  /** True only on the boot that generated the password. */
  created: boolean;
}

/**
 * Resolve the operator console's password for a deployment that cannot be left
 * unauthenticated — today, `FOUNDRY_GATEWAY_BIND=container` (TDD 0043). An
 * operator-set `SKEINKEEPER_OPERATOR_PASSWORD_HASH` always wins and never
 * reaches here; otherwise generate one and persist it 0600 under dataDir,
 * mirroring `loadOrCreatePairingSecret` (foundry_source.ts) and the
 * installation-id / salt dotfiles. Compose mounts the data dir, so the operator
 * logs in once rather than re-learning a password on every container
 * replacement.
 *
 * `created` exists so the caller can print the plaintext on the boot that made
 * it and never again: this credential grants full session control — start/stop,
 * live overrides, transcripts — and `docker logs` output routinely ends up
 * pasted into a support thread. Later boots should log the file's path instead.
 */
export function loadOrCreateConsolePassword(dataDir: string): ConsoleCredential {
  const path = join(dataDir, CONSOLE_PASSWORD_FILE);
  if (existsSync(path)) {
    const raw = readFileSync(path, "utf8").trim();
    if (raw.length >= 16) return { password: raw, hash: hashPassword(raw), created: false };
  }
  const password = randomBytes(18).toString("base64url");
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(path, password, { mode: 0o600 });
  return { password, hash: hashPassword(password), created: true };
}
