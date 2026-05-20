// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

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
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: unknown };
    return typeof claims.exp === "number" && now < claims.exp;
  } catch {
    return false;
  }
}
