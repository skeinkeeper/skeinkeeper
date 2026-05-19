// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import type { Expectation, Fixture } from "./fixture.js";
import type { RunnerOutput } from "./runner.js";

export interface ExpectationResult {
  kind: string;
  status: "pass" | "fail";
  message?: string;
}

export interface FixtureResult {
  name: string;
  path: string;
  status: "pass" | "fail" | "skipped";
  reason?: string;
  expectations: ReadonlyArray<ExpectationResult>;
}

export interface EvalReport {
  fixtures: ReadonlyArray<FixtureResult>;
  totals: { pass: number; fail: number; skipped: number };
}

export function evaluate(fixture: Fixture, output: RunnerOutput): FixtureResult {
  if (fixture.skip) {
    return {
      name: fixture.name,
      path: fixture.path,
      status: "skipped",
      reason: fixture.skip,
      expectations: [],
    };
  }
  const expectations = fixture.expectations.map((e) => evalExpectation(e, output));
  const status: FixtureResult["status"] = expectations.some((e) => e.status === "fail")
    ? "fail"
    : "pass";
  return { name: fixture.name, path: fixture.path, status, expectations };
}

function evalExpectation(e: Expectation, output: RunnerOutput): ExpectationResult {
  if (e.kind === "tool_called") {
    const hit = (output.toolCalls ?? []).some((tc) => tc.name === e.name);
    return hit
      ? { kind: e.kind, status: "pass" }
      : {
          kind: e.kind,
          status: "fail",
          message: `Tool "${e.name}" was not called. Calls: [${
            (output.toolCalls ?? []).map((tc) => tc.name).join(", ")
          }]`,
        };
  }
  if (e.kind === "tool_not_called") {
    const hit = (output.toolCalls ?? []).some((tc) => tc.name === e.name);
    return hit
      ? {
          kind: e.kind,
          status: "fail",
          message: `Tool "${e.name}" was unexpectedly called.`,
        }
      : { kind: e.kind, status: "pass" };
  }

  const value = readField(output, e.field);
  switch (e.kind) {
    case "not_empty":
      return value && value.trim().length > 0
        ? { kind: e.kind, status: "pass" }
        : { kind: e.kind, status: "fail", message: `Field "${e.field}" is empty.` };
    case "contains":
      return value.toLowerCase().includes(e.text.toLowerCase())
        ? { kind: e.kind, status: "pass" }
        : { kind: e.kind, status: "fail", message: `"${e.text}" not in "${truncate(value)}"` };
    case "not_contains":
      return !value.toLowerCase().includes(e.text.toLowerCase())
        ? { kind: e.kind, status: "pass" }
        : { kind: e.kind, status: "fail", message: `"${e.text}" unexpectedly in "${truncate(value)}"` };
    case "contains_any_of": {
      const hit = e.texts.find((t) => value.toLowerCase().includes(t.toLowerCase()));
      return hit
        ? { kind: e.kind, status: "pass" }
        : {
            kind: e.kind,
            status: "fail",
            message: `None of [${e.texts.join(", ")}] in "${truncate(value)}"`,
          };
    }
    case "regex_match": {
      const re = new RegExp(e.pattern);
      return re.test(value)
        ? { kind: e.kind, status: "pass" }
        : {
            kind: e.kind,
            status: "fail",
            message: `/${e.pattern}/ did not match "${truncate(value)}"`,
          };
    }
  }
}

function readField(output: RunnerOutput, field: string): string {
  if (field === "narration") return output.narration;
  return "";
}

function truncate(s: string, max = 80): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

export function summarize(fixtures: ReadonlyArray<FixtureResult>): EvalReport {
  const totals = { pass: 0, fail: 0, skipped: 0 };
  for (const f of fixtures) totals[f.status]++;
  return { fixtures, totals };
}

export function formatTextReport(report: EvalReport): string {
  const lines: string[] = [];
  for (const f of report.fixtures) {
    const icon = f.status === "pass" ? "✓" : f.status === "fail" ? "✗" : "○";
    lines.push(`${icon} ${f.name} — ${f.path}`);
    if (f.status === "skipped" && f.reason) lines.push(`    skipped: ${f.reason}`);
    for (const e of f.expectations) {
      if (e.status === "fail") lines.push(`    ✗ ${e.kind}: ${e.message ?? ""}`);
    }
  }
  lines.push("");
  lines.push(`Totals: ${report.totals.pass} pass, ${report.totals.fail} fail, ${report.totals.skipped} skipped.`);
  return lines.join("\n");
}

export function formatMarkdownReport(report: EvalReport): string {
  const lines: string[] = ["### Eval results", ""];
  lines.push(
    `**${report.totals.pass}** pass · **${report.totals.fail}** fail · **${report.totals.skipped}** skipped`,
  );
  const fails = report.fixtures.filter((f) => f.status === "fail");
  if (fails.length === 0) {
    lines.push("");
    lines.push("All expectations passed.");
    return lines.join("\n");
  }
  lines.push("", "#### Failures", "");
  for (const f of fails) {
    lines.push(`- **${f.name}** (\`${f.path}\`)`);
    for (const e of f.expectations) {
      if (e.status === "fail") lines.push(`  - \`${e.kind}\`: ${e.message ?? ""}`);
    }
  }
  return lines.join("\n");
}
