// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import type { Fixture } from "./fixture.js";

export interface RunnerInput {
  fixture: Fixture;
}

export interface RunnerOutput {
  narration: string;
  // Reserved for future kinds: toolCalls, stateAfter, whispers, etc.
}

export interface Runner {
  readonly name: string;
  run(input: RunnerInput): Promise<RunnerOutput>;
}

/**
 * Deterministic stub runner used until Phase 1.5 wires the real
 * LLMProvider. Echoes the last player turn so fixtures can exercise
 * the harness end-to-end without an LLM call.
 */
export class MockRunner implements Runner {
  readonly name = "mock";

  async run({ fixture }: RunnerInput): Promise<RunnerOutput> {
    const lastPlayer = [...fixture.scenario.turns].reverse().find((t) => t.speaker === "player");
    const text = lastPlayer?.text ?? "(no player input)";
    return { narration: `[stub narration in response to: ${text}]` };
  }
}
