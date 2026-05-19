// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

export type Speaker = "player" | "operator" | "system";

export interface Turn {
  speaker: Speaker;
  text: string;
}

export type Expectation =
  | { kind: "not_empty"; field: string; description?: string }
  | { kind: "contains"; field: string; text: string; description?: string }
  | { kind: "contains_any_of"; field: string; texts: ReadonlyArray<string>; description?: string }
  | { kind: "not_contains"; field: string; text: string; description?: string }
  | { kind: "regex_match"; field: string; pattern: string; description?: string };

export interface Scenario {
  state?: Record<string, unknown>;
  turns: ReadonlyArray<Turn>;
}

export interface Fixture {
  /** Source file path, populated by the loader. */
  path: string;
  name: string;
  description?: string;
  behaviorSpecVersion?: string;
  /** Non-empty string => skip with this reason. */
  skip?: string;
  scenario: Scenario;
  expectations: ReadonlyArray<Expectation>;
}
