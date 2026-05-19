// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadFixtures } from "./loader.js";
import { MockRunner } from "./runner.js";
import { evaluate, formatTextReport, summarize } from "./reporter.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(here, "..", "fixtures");
const REPORT_PATH = join(here, "..", "last-run.json");

async function main(): Promise<number> {
  const fixtures = loadFixtures(FIXTURES_DIR);
  if (fixtures.length === 0) {
    console.log(`No fixtures found in ${FIXTURES_DIR}.`);
    return 0;
  }

  const runner = new MockRunner();
  const results = [];
  for (const fixture of fixtures) {
    if (fixture.skip) {
      results.push(evaluate(fixture, { narration: "" }));
      continue;
    }
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
