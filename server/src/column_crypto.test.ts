// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { describe, expect, it } from "vitest";
import { createPiiCrypto, PiiDecryptError } from "./column_crypto.js";
import type { KeySource } from "./secret_store.js";

const SALT = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const src = (pass?: string): KeySource => ({ getPassphrase: () => pass });

describe("PiiCrypto — enabled (passphrase set)", () => {
  const crypto = createPiiCrypto({ keySource: src("correct horse"), salt: SALT });

  it("reports enabled when a passphrase is available", () => {
    expect(crypto.enabled).toBe(true);
  });

  it("round-trips enc → dec", () => {
    expect(crypto.dec(crypto.enc("discord:42"))).toBe("discord:42");
  });

  it("tags ciphertext so it is distinguishable from plaintext", () => {
    expect(crypto.enc("discord:42").startsWith("gcm:")).toBe(true);
    expect(crypto.enc("discord:42")).not.toContain("discord:42");
  });

  it("uses a fresh IV so the same plaintext encrypts to different ciphertext", () => {
    const a = crypto.enc("discord:42");
    const b = crypto.enc("discord:42");
    expect(a).not.toBe(b);
    expect(crypto.dec(a)).toBe("discord:42");
    expect(crypto.dec(b)).toBe("discord:42");
  });

  it("decrypts legacy plaintext (untagged) unchanged, for mixed migration state", () => {
    expect(crypto.dec("discord:legacy")).toBe("discord:legacy");
  });

  it("throws PiiDecryptError on tampered ciphertext", () => {
    const ct = crypto.enc("discord:42");
    const tampered = ct.slice(0, -4) + "AAAA";
    expect(() => crypto.dec(tampered)).toThrow(PiiDecryptError);
  });

  it("throws PiiDecryptError when decrypting under the wrong passphrase", () => {
    const ct = crypto.enc("discord:42");
    const other = createPiiCrypto({ keySource: src("wrong passphrase"), salt: SALT });
    expect(() => other.dec(ct)).toThrow(PiiDecryptError);
  });
});

describe("PiiCrypto — disabled (no passphrase)", () => {
  const crypto = createPiiCrypto({ keySource: src(undefined), salt: SALT });

  it("reports disabled when no passphrase is available", () => {
    expect(crypto.enabled).toBe(false);
  });

  it("passes enc/dec through unchanged (plaintext at rest, the alpha default)", () => {
    expect(crypto.enc("discord:42")).toBe("discord:42");
    expect(crypto.dec("discord:42")).toBe("discord:42");
  });
});

describe("PiiCrypto — hash companion (always available)", () => {
  it("is deterministic and a 64-char hex digest", () => {
    const crypto = createPiiCrypto({ keySource: src(undefined), salt: SALT });
    const h = crypto.hash("discord:42");
    expect(h).toBe(crypto.hash("discord:42"));
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it("does not leak the plaintext value", () => {
    const crypto = createPiiCrypto({ keySource: src("pw"), salt: SALT });
    expect(crypto.hash("discord:42")).not.toContain("discord:42");
  });

  it("differs across installations (different salt → different hash)", () => {
    const a = createPiiCrypto({ keySource: src(undefined), salt: SALT });
    const b = createPiiCrypto({ keySource: src(undefined), salt: "f".repeat(64) });
    expect(a.hash("discord:42")).not.toBe(b.hash("discord:42"));
  });

  it("is available with and without a passphrase, and agrees for the same salt", () => {
    const off = createPiiCrypto({ keySource: src(undefined), salt: SALT });
    const on = createPiiCrypto({ keySource: src("pw"), salt: SALT });
    expect(off.hash("discord:42")).toBe(on.hash("discord:42"));
  });
});
