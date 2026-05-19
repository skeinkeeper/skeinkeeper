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
