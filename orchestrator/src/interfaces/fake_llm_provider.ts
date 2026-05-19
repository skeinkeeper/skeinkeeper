// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import type {
  LLMEvent,
  LLMOptions,
  LLMProvider,
  LLMRequest,
  TokenUsage,
} from "./llm.js";

/**
 * One scripted response. If `match` is provided and returns false for a
 * given request, the next script is tried. The first script with no
 * `match` (or whose `match` returns true) wins.
 */
export interface FakeScript {
  match?: (req: LLMRequest) => boolean;
  events: ReadonlyArray<LLMEvent>;
}

/**
 * Scripted in-memory LLMProvider for unit tests and the eval harness
 * (replacing the MockRunner placeholder per design doc 0004).
 *
 * Per design doc 0008 § "FakeLLMProvider for tests and the eval harness."
 */
export class FakeLLMProvider implements LLMProvider {
  readonly name = "fake";
  /** Captured requests, in order. Useful for assertions in tests
   *  ("the runner sent the right system prompt"). */
  readonly receivedRequests: LLMRequest[] = [];

  constructor(private readonly scripts: ReadonlyArray<FakeScript>) {
    if (scripts.length === 0) {
      throw new Error("FakeLLMProvider requires at least one script.");
    }
  }

  async *complete(req: LLMRequest, opts: LLMOptions = {}): AsyncIterable<LLMEvent> {
    this.receivedRequests.push(req);
    const script = this.scripts.find((s) => !s.match || s.match(req));
    if (!script) {
      yield {
        kind: "error",
        error: {
          kind: "invalid_request",
          message: "FakeLLMProvider: no matching script for request.",
        },
      };
      return;
    }

    let lastUsage: TokenUsage | undefined;

    for (const ev of script.events) {
      if (opts.signal?.aborted) {
        yield {
          kind: "error",
          error: { kind: "cancelled", message: "FakeLLMProvider: aborted." },
        };
        return;
      }
      if (ev.kind === "done") lastUsage = ev.usage;
      yield ev;
      if (ev.kind === "done" || ev.kind === "error") break;
    }

    if (lastUsage && opts.onUsage) opts.onUsage(lastUsage);
  }
}

/**
 * Convenience constructor: a single-script fake that emits the given events
 * in order. The single most common test setup.
 */
export function fakeLlmFromEvents(events: ReadonlyArray<LLMEvent>): FakeLLMProvider {
  return new FakeLLMProvider([{ events }]);
}
