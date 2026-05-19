// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BehaviorSpecError,
  assertSpecCompatible,
  bucketSpecSizeKb,
  findDefaultBehaviorSpec,
  loadBehaviorSpec,
} from "./behavior.js";

function tmpFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "behavior-spec-test-"));
  const path = join(dir, "spec.md");
  writeFileSync(path, content);
  return path;
}

describe("loadBehaviorSpec", () => {
  it("loads a spec and extracts the version", () => {
    const path = tmpFile(`# Skeinkeeper — Behavior Spec\n**v0.1 (Draft) · ...**\n\nFreeform content here.`);
    const spec = loadBehaviorSpec(path);
    expect(spec.version).toBe("v0.1");
    expect(spec.content).toContain("Freeform content here.");
    expect(spec.path).toBe(path);
  });

  it("captures only MAJOR.MINOR (ignores status suffixes like (Draft))", () => {
    const path = tmpFile(`**v1.2 (Release Candidate) · stuff**\n`);
    expect(loadBehaviorSpec(path).version).toBe("v1.2");
  });

  it("handles a version line without surrounding text", () => {
    const path = tmpFile(`**v0.3**\n\nContent.`);
    expect(loadBehaviorSpec(path).version).toBe("v0.3");
  });

  it("throws BehaviorSpecError if the file doesn't exist", () => {
    expect(() => loadBehaviorSpec("/nonexistent/path/spec.md")).toThrow(BehaviorSpecError);
  });

  it("throws if no version line is present in the first 500 bytes", () => {
    const path = tmpFile(`# Header without version metadata.\n\n` + "filler. ".repeat(100) + `**v0.1**`);
    expect(() => loadBehaviorSpec(path)).toThrow(/version line/);
  });

  it("requires the version to look like vN.N (not just a number)", () => {
    const path = tmpFile(`# Spec\n**version 1**\n`);
    expect(() => loadBehaviorSpec(path)).toThrow(/version line/);
  });
});

describe("assertSpecCompatible", () => {
  const spec = {
    content: "irrelevant",
    version: "v0.1",
    path: "/tmp/x.md",
  };

  it("accepts matching versions", () => {
    expect(() => assertSpecCompatible(spec, "v0.1")).not.toThrow();
  });

  it("throws on mismatch with a message naming both versions", () => {
    try {
      assertSpecCompatible(spec, "v0.2");
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(BehaviorSpecError);
      const msg = (err as Error).message;
      expect(msg).toContain("v0.1");
      expect(msg).toContain("v0.2");
    }
  });
});

describe("findDefaultBehaviorSpec", () => {
  it("finds behavior/default.md in an ancestor directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "find-spec-test-"));
    mkdirSync(join(dir, "behavior"));
    mkdirSync(join(dir, "deep", "nested", "path"), { recursive: true });
    const specPath = join(dir, "behavior", "default.md");
    writeFileSync(specPath, "**v0.1**\nx");
    const found = findDefaultBehaviorSpec(join(dir, "deep", "nested", "path"));
    expect(found).toBe(specPath);
  });

  it("throws if no behavior/default.md exists walking up to /", () => {
    const dir = mkdtempSync(join(tmpdir(), "find-spec-test-"));
    expect(() => findDefaultBehaviorSpec(dir)).toThrow(/Could not find/);
  });
});

describe("bucketSpecSizeKb", () => {
  it("buckets sizes coarsely", () => {
    expect(bucketSpecSizeKb(500)).toBe("<5"); // 0.5KB
    expect(bucketSpecSizeKb(10_000)).toBe("<15"); // ~10KB
    expect(bucketSpecSizeKb(30_000)).toBe("<50"); // ~30KB
    expect(bucketSpecSizeKb(100_000)).toBe(">=50"); // ~100KB
  });
});

describe("loads the real project spec", () => {
  it("finds and parses behavior/default.md from the repo", () => {
    const path = findDefaultBehaviorSpec(import.meta.dirname);
    const spec = loadBehaviorSpec(path);
    expect(spec.version).toMatch(/^v\d+\.\d+$/);
    expect(spec.content.length).toBeGreaterThan(1000);
  });
});
