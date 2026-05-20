// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

/**
 * Live eval: run the fixtures against the REAL Anthropic model + the real
 * behavior spec + real tool dispatch — the non-tautological complement to the
 * scripted CI harness (which fakes the model). This is what actually exercises
 * the model's judgment and the behavior spec.
 *
 *   ANTHROPIC_API_KEY=… pnpm eval:live
 *
 * Manual + nondeterministic (real model), so it's NOT part of CI. Skips cleanly
 * (exit 0) when no API key is set. Exits non-zero if any fixture fails so it can
 * be wired into an opt-in gate later.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AnthropicProvider } from "@skeinkeeper/llm-anthropic";
import { loadFixtures } from "./loader.js";
import { OrchestratorRunner } from "./orchestrator_runner.js";
import { evaluate, formatTextReport, summarize } from "./reporter.js";
import type { FixtureResult } from "./reporter.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(here, "..", "fixtures");

async function main(): Promise<number> {
  const apiKey = process.env["ANTHROPIC_API_KEY"];
  if (apiKey === undefined || apiKey.trim().length === 0) {
    console.log(
      "eval:live skipped — set ANTHROPIC_API_KEY to run the fixtures against the real model.",
    );
    return 0;
  }

  const fixtures = loadFixtures(FIXTURES_DIR);
  if (fixtures.length === 0) {
    console.log(`No fixtures found in ${FIXTURES_DIR}.`);
    return 0;
  }

  const provider = new AnthropicProvider({ apiKey });
  const runner = new OrchestratorRunner(provider);
  console.log(`Running ${fixtures.length} fixture(s) against the live model…\n`);

  const results: FixtureResult[] = [];
  for (const fixture of fixtures) {
    if (fixture.skip) {
      results.push(evaluate(fixture, { narration: "" }));
      continue;
    }
    // Live runs use the REAL behavior spec (unless the fixture pins an inline
    // one) so the model is judged against what ships.
    const liveFixture = { ...fixture, behaviorSpec: fixture.behaviorSpec ?? ("default" as const) };
    try {
      const output = await runner.run({ fixture: liveFixture });
      results.push(evaluate(fixture, output));
    } catch (err) {
      results.push({
        name: fixture.name,
        path: fixture.path,
        status: "fail",
        expectations: [
          {
            kind: "fixture",
            status: "fail",
            message: `Live run threw: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
      });
    }
  }

  const report = summarize(results);
  console.log(formatTextReport(report));
  return report.totals.fail > 0 ? 1 : 0;
}

process.exit(await main());
