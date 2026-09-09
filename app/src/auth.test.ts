// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  hashPassword,
  verifyPassword,
  mintToken,
  verifyToken,
  loadOrCreateConsolePassword,
} from "./auth.js";

describe("password hashing", () => {
  it("verifies the correct password and rejects wrong ones", () => {
    const stored = hashPassword("correct horse battery staple");
    expect(verifyPassword("correct horse battery staple", stored)).toBe(true);
    expect(verifyPassword("wrong", stored)).toBe(false);
  });

  it("salts — same password hashes differently each time", () => {
    expect(hashPassword("pw")).not.toBe(hashPassword("pw"));
  });

  it("rejects malformed stored hashes", () => {
    expect(verifyPassword("pw", "garbage")).toBe(false);
  });
});

describe("session tokens", () => {
  const secret = "server-secret";

  it("accepts a freshly minted token and rejects a tampered one", () => {
    const token = mintToken(secret, "operator", Date.now() + 60_000);
    expect(verifyToken(secret, token)).toBe(true);
    expect(verifyToken(secret, token + "x")).toBe(false);
    expect(verifyToken("other-secret", token)).toBe(false);
  });

  it("rejects an expired token", () => {
    const token = mintToken(secret, "operator", 1000);
    expect(verifyToken(secret, token, 2000)).toBe(false);
  });
});

describe("loadOrCreateConsolePassword (TDD 0043)", () => {
  const freshDir = (): string => mkdtempSync(join(tmpdir(), "skein-console-pw-"));

  it("generates, persists 0600, and reports that it created the credential", () => {
    const dir = freshDir();
    const first = loadOrCreateConsolePassword(dir);

    expect(first.created).toBe(true);
    expect(first.password.length).toBeGreaterThanOrEqual(16);
    expect(verifyPassword(first.password, first.hash)).toBe(true);
    expect(verifyPassword("not-the-password", first.hash)).toBe(false);

    const path = join(dir, ".console-password");
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(first.password);
    expect(statSync(path).mode & 0o777).toBe(0o600); // owner-only
  });

  it("reuses the persisted password on a later boot, with created false", () => {
    // `created` is what gates printing the plaintext: the console credential
    // grants full session control, so it must not be re-emitted into container
    // logs on every restart.
    const dir = freshDir();
    const first = loadOrCreateConsolePassword(dir);
    const second = loadOrCreateConsolePassword(dir);

    expect(second.created).toBe(false);
    expect(second.password).toBe(first.password);
    expect(verifyPassword(first.password, second.hash)).toBe(true);
  });

  it("creates the data dir when it does not exist yet", () => {
    const dir = join(freshDir(), "nested", "data");
    const cred = loadOrCreateConsolePassword(dir);
    expect(cred.created).toBe(true);
    expect(existsSync(join(dir, ".console-password"))).toBe(true);
  });

  it("regenerates when the stored value is truncated or blank", () => {
    const dir = freshDir();
    const path = join(dir, ".console-password");
    writeFileSync(path, "  \n", { mode: 0o600 });

    const cred = loadOrCreateConsolePassword(dir);
    expect(cred.created).toBe(true);
    expect(cred.password.length).toBeGreaterThanOrEqual(16);
    expect(readFileSync(path, "utf8")).toBe(cred.password);
  });
});
