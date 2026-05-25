// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { describe, expect, it } from "vitest";
import { seal, open, SecretOpenError } from "./secrets.js";

describe("sealed secrets", () => {
  it("round-trips a value with the right passphrase", () => {
    const sealed = seal("operator-pass", "sk-ant-secret-key");
    expect(sealed).not.toContain("sk-ant-secret-key");
    expect(open("operator-pass", sealed)).toBe("sk-ant-secret-key");
  });

  it("fails to open with the wrong passphrase", () => {
    const sealed = seal("right", "value");
    expect(() => open("wrong", sealed)).toThrow(SecretOpenError);
  });

  it("rejects a malformed sealed value", () => {
    expect(() => open("pass", "not-sealed")).toThrow(SecretOpenError);
  });
});
