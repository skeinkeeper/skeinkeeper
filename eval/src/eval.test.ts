// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { describe, expect, it } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadFixtures, loadFixture } from "./loader.js";
import { MockRunner } from "./runner.js";
import { evaluate, summarize, formatMarkdownReport } from "./reporter.js";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(here, "..", "fixtures");

describe("loader", () => {
  it("loads the smoke fixture from disk", () => {
    const fixtures = loadFixtures(FIXTURES_DIR);
    expect(fixtures.length).toBeGreaterThan(0);
    const smoke = fixtures.find((f) => f.name === "harness-smoke");
    expect(smoke).toBeDefined();
    expect(smoke?.expectations).toHaveLength(2);
  });

  it("rejects fixtures missing required fields", () => {
    const dir = mkdtempSync(join(tmpdir(), "evaltest-"));
    const bad = join(dir, "broken.eval.yaml");
    writeFileSync(bad, "name: missing-scenario\n");
    expect(() => loadFixture(bad)).toThrow(/scenario/);
  });

  it("rejects unknown expectation kinds", () => {
    const dir = mkdtempSync(join(tmpdir(), "evaltest-"));
    const bad = join(dir, "broken.eval.yaml");
    writeFileSync(
      bad,
      `name: bad-kind
scenario:
  turns: [{speaker: player, text: hi}]
expectations:
  - kind: invalid_kind
`,
    );
    expect(() => loadFixture(bad)).toThrow(/unknown expectation kind/);
  });
});

describe("MockRunner + evaluate", () => {
  it("passes the smoke fixture", async () => {
    const fixtures = loadFixtures(FIXTURES_DIR);
    const smoke = fixtures.find((f) => f.name === "harness-smoke")!;
    const out = await new MockRunner().run({ fixture: smoke });
    const result = evaluate(smoke, out);
    expect(result.status).toBe("pass");
    expect(result.expectations.every((e) => e.status === "pass")).toBe(true);
  });

  it("fails a fixture whose expectation doesn't match", async () => {
    const dir = mkdtempSync(join(tmpdir(), "evaltest-"));
    const path = join(dir, "fail.eval.yaml");
    writeFileSync(
      path,
      `name: must-fail
scenario:
  turns: [{speaker: player, text: hello}]
expectations:
  - kind: contains
    field: narration
    text: this-string-will-never-appear
`,
    );
    const fixture = loadFixture(path);
    const out = await new MockRunner().run({ fixture });
    const result = evaluate(fixture, out);
    expect(result.status).toBe("fail");
  });

  it("marks skip-tagged fixtures as skipped", () => {
    const dir = mkdtempSync(join(tmpdir(), "evaltest-"));
    const path = join(dir, "skipped.eval.yaml");
    writeFileSync(
      path,
      `name: skipme
skip: waiting on real LLM
scenario:
  turns: [{speaker: player, text: hi}]
expectations:
  - kind: not_empty
    field: narration
`,
    );
    const fixture = loadFixture(path);
    const result = evaluate(fixture, { narration: "" });
    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("waiting on real LLM");
  });
});

describe("reporter", () => {
  it("totals across fixtures", () => {
    const report = summarize([
      {
        name: "a",
        path: "x",
        status: "pass",
        expectations: [{ kind: "not_empty", status: "pass" }],
      },
      {
        name: "b",
        path: "y",
        status: "fail",
        expectations: [{ kind: "contains", status: "fail", message: "nope" }],
      },
      { name: "c", path: "z", status: "skipped", reason: "later", expectations: [] },
    ]);
    expect(report.totals).toEqual({ pass: 1, fail: 1, skipped: 1 });
  });

  it("formats markdown succinctly when all green", () => {
    const md = formatMarkdownReport({
      fixtures: [
        { name: "a", path: "x", status: "pass", expectations: [] },
      ],
      totals: { pass: 1, fail: 0, skipped: 0 },
    });
    expect(md).toContain("All expectations passed");
    expect(md).not.toContain("Failures");
  });

  it("lists failures in markdown when present", () => {
    const md = formatMarkdownReport({
      fixtures: [
        {
          name: "a",
          path: "x",
          status: "fail",
          expectations: [{ kind: "contains", status: "fail", message: "nope" }],
        },
      ],
      totals: { pass: 0, fail: 1, skipped: 0 },
    });
    expect(md).toContain("Failures");
    expect(md).toContain("nope");
  });
});
