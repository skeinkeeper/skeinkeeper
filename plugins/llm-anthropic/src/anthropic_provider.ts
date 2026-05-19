// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import Anthropic from "@anthropic-ai/sdk";
import {
  bucketDurationMs,
  bucketTokens,
  type Effort,
  type LLMEvent,
  type LLMOptions,
  type LLMProvider,
  type LLMRequest,
  type StopReason,
  type TokenUsage,
} from "@skeinkeeper/orchestrator";
import type { AnalyticsClient } from "@skeinkeeper/telemetry";
import { translateError } from "./translate_error.js";
import { translateRequest, type RequestTranslationConfig } from "./translate_request.js";
import { translateStreamEvents } from "./translate_event.js";

export interface AnthropicProviderConfig {
  apiKey: string;
  /** Defaults to "claude-opus-4-7". */
  modelNarration?: string;
  /** Defaults to "claude-haiku-4-5". */
  modelOrchestration?: string;
  baseURL?: string;
  /** Defaults to "xhigh" on narration (the Opus 4.7 sweet spot). */
  defaultEffortNarration?: Effort;
  /** Defaults to "high" on orchestration. */
  defaultEffortOrchestration?: Effort;
  /** Defaults to 8192. */
  defaultMaxTokens?: number;
  /** Beta features to enable. Defaults to compaction + task budgets. */
  betaHeaders?: ReadonlyArray<string>;
  /** Optional analytics client; emits `llm.completed` per design doc 0008. */
  analytics?: AnalyticsClient;
}

const DEFAULT_BETA_HEADERS: ReadonlyArray<string> = [
  "compact-2026-01-12",
  "task-budgets-2026-03-13",
];

/**
 * Anthropic implementation of LLMProvider. See design doc 0008.
 *
 * Streaming-first via `client.beta.messages.stream()` so we get compaction
 * blocks in responses; the regular endpoint would work too but with a
 * narrower feature set. Beta-headers can be overridden in config.
 */
export class AnthropicProvider implements LLMProvider {
  readonly name = "anthropic";
  private readonly client: Anthropic;
  private readonly translationConfig: RequestTranslationConfig;
  private readonly betaHeaders: ReadonlyArray<string>;
  private readonly analytics: AnalyticsClient | undefined;

  constructor(cfg: AnthropicProviderConfig) {
    this.client = new Anthropic({
      apiKey: cfg.apiKey,
      ...(cfg.baseURL !== undefined ? { baseURL: cfg.baseURL } : {}),
    });
    this.translationConfig = {
      modelNarration: cfg.modelNarration ?? "claude-opus-4-7",
      modelOrchestration: cfg.modelOrchestration ?? "claude-haiku-4-5",
      defaultEffortNarration: cfg.defaultEffortNarration ?? "xhigh",
      defaultEffortOrchestration: cfg.defaultEffortOrchestration ?? "high",
      defaultMaxTokens: cfg.defaultMaxTokens ?? 8192,
    };
    this.betaHeaders = cfg.betaHeaders ?? DEFAULT_BETA_HEADERS;
    this.analytics = cfg.analytics;
  }

  async *complete(
    req: LLMRequest,
    opts: LLMOptions = {},
  ): AsyncIterable<LLMEvent> {
    const params = translateRequest(req, this.translationConfig);
    const startMs = Date.now();
    let success = false;
    let stopReason: StopReason = "end_turn";
    let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };

    let stream: ReturnType<typeof this.client.beta.messages.stream> | undefined;
    try {
      stream = this.client.beta.messages.stream(params, {
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
        headers: { "anthropic-beta": this.betaHeaders.join(",") },
      });

      try {
        for await (const ev of translateStreamEvents(stream)) {
          if (ev.kind === "done") {
            success = true;
            stopReason = ev.stopReason;
            usage = ev.usage;
            if (opts.onUsage) opts.onUsage(usage);
          }
          yield ev;
        }
      } finally {
        // Tear down the SDK stream if the consumer broke early.
        try {
          stream.controller?.abort();
        } catch {
          // ignore — best-effort cleanup
        }
      }
    } catch (err) {
      yield { kind: "error", error: translateError(err) };
    } finally {
      const durationMs = Date.now() - startMs;
      this.analytics?.track("llm.completed", {
        providerName: "anthropic",
        modelTier: req.modelTier,
        success,
        stopReason: success ? stopReason : "error",
        inputTokensBucket: bucketTokens(usage.inputTokens),
        outputTokensBucket: bucketTokens(usage.outputTokens),
        cacheReadTokensBucket: bucketTokens(usage.cacheReadInputTokens ?? 0),
        durationMsBucket: bucketDurationMs(durationMs),
      });
    }
  }
}
