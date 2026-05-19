// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { describe, expect, it } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadFixtures, loadFixture } from "./loader.js";
import { OrchestratorRunner } from "./orchestrator_runner.js";
import { fakeLlmFromScript } from "./llm_script.js";
import { evaluate, summarize, formatMarkdownReport } from "./reporter.js";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(here, "..", "fixtures");

describe("loader", () => {
  it("loads the smoke fixtures from disk", () => {
    const fixtures = loadFixtures(FIXTURES_DIR);
    expect(fixtures.length).toBeGreaterThan(0);
    const smoke = fixtures.find((f) => f.name === "harness-smoke");
    expect(smoke).toBeDefined();
    expect(smoke?.expectations).toHaveLength(2);
    expect(smoke?.llmScript?.narration).toContain("dusty room");
  });

  it("loads the tool-call fixture with parsed tool_calls", () => {
    const fixtures = loadFixtures(FIXTURES_DIR);
    const tc = fixtures.find((f) => f.name === "tool-call-smoke");
    expect(tc).toBeDefined();
    expect(tc?.llmScript?.toolCalls).toHaveLength(2);
    expect(tc?.llmScript?.toolCalls?.[0]?.name).toBe("roll");
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

  it("rejects malformed llm_script.tool_calls entries", () => {
    const dir = mkdtempSync(join(tmpdir(), "evaltest-"));
    const bad = join(dir, "broken.eval.yaml");
    writeFileSync(
      bad,
      `name: bad-script
scenario:
  turns: [{speaker: player, text: hi}]
llm_script:
  tool_calls:
    - input: {}
expectations:
  - kind: not_empty
    field: narration
`,
    );
    expect(() => loadFixture(bad)).toThrow(/name/);
  });

  it("rejects tool_called expectations without a name", () => {
    const dir = mkdtempSync(join(tmpdir(), "evaltest-"));
    const bad = join(dir, "broken.eval.yaml");
    writeFileSync(
      bad,
      `name: bad-tool-expect
scenario:
  turns: [{speaker: player, text: hi}]
expectations:
  - kind: tool_called
`,
    );
    expect(() => loadFixture(bad)).toThrow(/requires non-empty string "name"/);
  });
});

describe("OrchestratorRunner + evaluate", () => {
  it("passes the harness-smoke fixture", async () => {
    const fixtures = loadFixtures(FIXTURES_DIR);
    const smoke = fixtures.find((f) => f.name === "harness-smoke")!;
    const runner = new OrchestratorRunner(fakeLlmFromScript(smoke.llmScript!));
    const out = await runner.run({ fixture: smoke });
    const result = evaluate(smoke, out);
    expect(result.status).toBe("pass");
    expect(result.expectations.every((e) => e.status === "pass")).toBe(true);
  });

  it("passes the tool-call-smoke fixture with tool_called + tool_not_called expectations", async () => {
    const fixtures = loadFixtures(FIXTURES_DIR);
    const tc = fixtures.find((f) => f.name === "tool-call-smoke")!;
    const runner = new OrchestratorRunner(fakeLlmFromScript(tc.llmScript!));
    const out = await runner.run({ fixture: tc });
    const result = evaluate(tc, out);
    expect(result.status).toBe("pass");
  });

  it("fails when a tool_called expectation isn't satisfied", async () => {
    const dir = mkdtempSync(join(tmpdir(), "evaltest-"));
    const path = join(dir, "fail.eval.yaml");
    writeFileSync(
      path,
      `name: must-fail
scenario:
  turns: [{speaker: player, text: hi}]
llm_script:
  narration: "..."
expectations:
  - kind: tool_called
    name: roll
`,
    );
    const fixture = loadFixture(path);
    const runner = new OrchestratorRunner(fakeLlmFromScript(fixture.llmScript!));
    const out = await runner.run({ fixture });
    const result = evaluate(fixture, out);
    expect(result.status).toBe("fail");
  });

  it("fails when a tool_not_called expectation is violated", async () => {
    const dir = mkdtempSync(join(tmpdir(), "evaltest-"));
    const path = join(dir, "fail2.eval.yaml");
    writeFileSync(
      path,
      `name: must-fail-2
scenario:
  turns: [{speaker: player, text: hi}]
llm_script:
  tool_calls:
    - name: fudge_roll
      input: { originalTotal: 1, newTotal: 20, reason: "saving the arc" }
expectations:
  - kind: tool_not_called
    name: fudge_roll
`,
    );
    const fixture = loadFixture(path);
    const runner = new OrchestratorRunner(fakeLlmFromScript(fixture.llmScript!));
    const out = await runner.run({ fixture });
    const result = evaluate(fixture, out);
    expect(result.status).toBe("fail");
  });

  it("marks skip-tagged fixtures as skipped", () => {
    const dir = mkdtempSync(join(tmpdir(), "evaltest-"));
    const path = join(dir, "skipped.eval.yaml");
    writeFileSync(
      path,
      `name: skipme
skip: waiting on Phase 1.6 behavior spec
scenario:
  turns: [{speaker: player, text: hi}]
llm_script:
  narration: "irrelevant"
expectations:
  - kind: not_empty
    field: narration
`,
    );
    const fixture = loadFixture(path);
    const result = evaluate(fixture, { narration: "" });
    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("waiting on Phase 1.6 behavior spec");
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
          expectations: [{ kind: "tool_called", status: "fail", message: "nope" }],
        },
      ],
      totals: { pass: 0, fail: 1, skipped: 0 },
    });
    expect(md).toContain("Failures");
    expect(md).toContain("nope");
  });
});
