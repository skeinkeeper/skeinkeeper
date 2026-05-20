// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import type { Fixture } from "./fixture.js";

export interface RunnerInput {
  fixture: Fixture;
}

export interface ToolCallRecord {
  id: string;
  name: string;
  input: unknown;
  /** Whether the call dispatched successfully against the real tool registry.
   *  `false` means the tool is unknown, operator-gated without the flag, or got
   *  invalid input — so a `tool_called` expectation isn't satisfied by the model
   *  merely *emitting* the call (it must actually be dispatchable). */
  ok?: boolean;
}

export interface RunnerOutput {
  narration: string;
  /** Tool calls the model emitted during this run, in order. */
  toolCalls?: ReadonlyArray<ToolCallRecord>;
}

export interface Runner {
  readonly name: string;
  run(input: RunnerInput): Promise<RunnerOutput>;
}
