// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

/**
 * Sealed secret values (hard rule #7, design doc 0020 §6). Provider API keys
 * are sealed at rest with a passphrase, so production secrets don't live in
 * plaintext .env. Authenticated AES-256-GCM with a scrypt-derived key — Node
 * crypto only, no dependencies. Pure round-trip functions, unit-tested; the
 * operator app reads them into config at boot from a sealed config file.
 */
const ALGO = "aes-256-gcm";

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, 32);
}

/** Seal plaintext under a passphrase → "salt.iv.tag.cipher" (base64). */
export function seal(passphrase: string, plaintext: string): string {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, deriveKey(passphrase, salt), iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [salt, iv, tag, enc].map((b) => b.toString("base64")).join(".");
}

export class SecretOpenError extends Error {
  constructor() {
    super("could not open sealed value (wrong passphrase or corrupt data)");
    this.name = "SecretOpenError";
  }
}

/** Open a sealed value with its passphrase. Throws SecretOpenError on failure. */
export function open(passphrase: string, sealed: string): string {
  const parts = sealed.split(".");
  if (parts.length !== 4) throw new SecretOpenError();
  try {
    const [salt, iv, tag, enc] = parts.map((p) => Buffer.from(p, "base64"));
    const decipher = createDecipheriv(ALGO, deriveKey(passphrase, salt!), iv!);
    decipher.setAuthTag(tag!);
    return Buffer.concat([decipher.update(enc!), decipher.final()]).toString("utf8");
  } catch {
    throw new SecretOpenError();
  }
}
