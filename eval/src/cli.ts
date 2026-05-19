// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadFixtures } from "./loader.js";
import { OrchestratorRunner } from "./orchestrator_runner.js";
import { fakeLlmFromScript } from "./llm_script.js";
import { evaluate, formatTextReport, summarize } from "./reporter.js";
import type { FixtureResult } from "./reporter.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(here, "..", "fixtures");
const REPORT_PATH = join(here, "..", "last-run.json");

async function main(): Promise<number> {
  const fixtures = loadFixtures(FIXTURES_DIR);
  if (fixtures.length === 0) {
    console.log(`No fixtures found in ${FIXTURES_DIR}.`);
    return 0;
  }

  const results: FixtureResult[] = [];
  for (const fixture of fixtures) {
    if (fixture.skip) {
      results.push(evaluate(fixture, { narration: "" }));
      continue;
    }
    if (!fixture.llmScript) {
      results.push({
        name: fixture.name,
        path: fixture.path,
        status: "fail",
        expectations: [
          {
            kind: "fixture",
            status: "fail",
            message: "Fixture has no `llm_script`; nothing to drive the FakeLLMProvider with.",
          },
        ],
      });
      continue;
    }
    const runner = new OrchestratorRunner(fakeLlmFromScript(fixture.llmScript));
    const output = await runner.run({ fixture });
    results.push(evaluate(fixture, output));
  }
  const report = summarize(results);

  console.log(formatTextReport(report));

  mkdirSync(dirname(REPORT_PATH), { recursive: true });
  writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));

  return report.totals.fail > 0 ? 1 : 0;
}

process.exit(await main());
