// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOrCreateSalt } from "./salt.js";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "sk-salt-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("loadOrCreateSalt", () => {
  it("generates a 64-hex-char (32-byte) salt on first run and persists it", () => {
    const path = join(tmp(), "nested", ".salt");
    const salt = loadOrCreateSalt(path);
    expect(salt).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(path, "utf8")).toBe(salt);
  });

  it("reuses the persisted salt across calls (stable subject hashing)", () => {
    const path = join(tmp(), ".salt");
    const first = loadOrCreateSalt(path);
    const second = loadOrCreateSalt(path);
    expect(second).toBe(first);
  });

  it("writes the salt file with 0600 permissions", () => {
    const path = join(tmp(), ".salt");
    loadOrCreateSalt(path);
    // Low 9 mode bits should be owner-read/write only.
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("regenerates when the existing salt is too short (corrupt/truncated)", () => {
    const path = join(tmp(), ".salt");
    writeFileSync(path, "short", { mode: 0o600 });
    const salt = loadOrCreateSalt(path);
    expect(salt).not.toBe("short");
    expect(salt).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(path, "utf8")).toBe(salt);
  });
});
