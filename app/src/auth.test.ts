// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword, mintToken, verifyToken } from "./auth.js";

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
