// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { describe, expect, it } from "vitest";
import type { LLMRequest } from "@skeinkeeper/orchestrator";
import { translateRequest, type RequestTranslationConfig } from "./translate_request.js";

const CFG: RequestTranslationConfig = {
  modelNarration: "claude-opus-4-7",
  modelOrchestration: "claude-haiku-4-5",
  defaultEffortNarration: "xhigh",
  defaultEffortOrchestration: "high",
  defaultMaxTokens: 8192,
};

function req(overrides: Partial<LLMRequest> = {}): LLMRequest {
  return {
    systemPrompt: "you are a helpful AI DM",
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    tools: [],
    modelTier: "narration",
    ...overrides,
  };
}

describe("translateRequest — model selection", () => {
  it("uses the narration model for narration tier", () => {
    const p = translateRequest(req({ modelTier: "narration" }), CFG);
    expect(p.model).toBe("claude-opus-4-7");
  });

  it("uses the orchestration model for orchestration tier", () => {
    const p = translateRequest(req({ modelTier: "orchestration" }), CFG);
    expect(p.model).toBe("claude-haiku-4-5");
  });
});

describe("translateRequest — effort", () => {
  it("sets effort to xhigh on the narration tier (Opus 4.7)", () => {
    const p = translateRequest(req({ modelTier: "narration" }), CFG);
    expect(p.output_config?.effort).toBe("xhigh");
  });

  it("omits effort entirely on Haiku 4.5 — the model rejects the parameter", () => {
    const p = translateRequest(req({ modelTier: "orchestration" }), CFG);
    expect(p.output_config).toBeUndefined();
  });

  it("honors per-request effort override on a model that supports effort", () => {
    const p = translateRequest(req({ effort: "max" }), CFG);
    expect(p.output_config?.effort).toBe("max");
  });

  it("still omits effort on Haiku even if effort is provided", () => {
    const p = translateRequest(req({ modelTier: "orchestration", effort: "max" }), CFG);
    expect(p.output_config).toBeUndefined();
  });
});

describe("translateRequest — adaptive thinking", () => {
  it("enables adaptive thinking on Opus 4.7", () => {
    const p = translateRequest(req({ modelTier: "narration" }), CFG);
    expect(p.thinking).toEqual({ type: "adaptive", display: "summarized" });
  });

  it("omits thinking on Haiku 4.5 (orchestration) — Haiku doesn't support it", () => {
    const p = translateRequest(req({ modelTier: "orchestration" }), CFG);
    expect(p.thinking).toBeUndefined();
  });
});

describe("translateRequest — system prompt caching", () => {
  it("caches the system prompt by default", () => {
    const p = translateRequest(req(), CFG);
    const sys = p.system as Array<{ cache_control?: unknown }>;
    expect(sys[0]?.cache_control).toEqual({ type: "ephemeral" });
  });

  it("does not cache when cacheSystemPrompt is false", () => {
    const p = translateRequest(req({ cacheSystemPrompt: false }), CFG);
    const sys = p.system as Array<{ cache_control?: unknown }>;
    expect(sys[0]?.cache_control).toBeUndefined();
  });
});

describe("translateRequest — tools", () => {
  it("omits the tools field when no tools provided", () => {
    const p = translateRequest(req({ tools: [] }), CFG);
    expect(p.tools).toBeUndefined();
  });

  it("caches the last tool to checkpoint the tool list", () => {
    const p = translateRequest(
      req({
        tools: [
          { name: "a", description: "A.", inputSchemaJson: { type: "object" } },
          { name: "b", description: "B.", inputSchemaJson: { type: "object" } },
        ],
      }),
      CFG,
    );
    const tools = p.tools as Array<{ name: string; cache_control?: unknown }>;
    expect(tools[0]?.cache_control).toBeUndefined();
    expect(tools[1]?.cache_control).toEqual({ type: "ephemeral" });
  });
});

describe("translateRequest — task budget", () => {
  it("sets task_budget on Opus 4.7 when taskBudgetTokens is provided", () => {
    const p = translateRequest(req({ taskBudgetTokens: 30_000 }), CFG);
    const oc = p.output_config as { task_budget?: { type: string; total: number } };
    expect(oc.task_budget).toEqual({ type: "tokens", total: 30_000 });
  });

  it("does not set task_budget on Haiku (output_config is omitted entirely)", () => {
    const p = translateRequest(
      req({ modelTier: "orchestration", taskBudgetTokens: 30_000 }),
      CFG,
    );
    expect(p.output_config).toBeUndefined();
  });

  it("does not set task_budget when not requested", () => {
    const p = translateRequest(req(), CFG);
    const oc = p.output_config as { task_budget?: unknown } | undefined;
    expect(oc?.task_budget).toBeUndefined();
  });
});

describe("translateRequest — audio content (design doc 0010)", () => {
  it("folds audio-with-transcript into a text block (with speaker prefix)", () => {
    const p = translateRequest(
      req({
        messages: [
          {
            role: "user",
            content: [
              {
                type: "audio",
                source: { kind: "base64", mediaType: "audio/wav", data: "AAAA" },
                transcript: "I draw my sword.",
                speakerName: "Aragorn",
              },
            ],
          },
        ],
      }),
      CFG,
    );
    const block = p.messages[0]?.content as Array<{ type: string; text?: string }>;
    expect(block[0]?.type).toBe("text");
    expect(block[0]?.text).toBe("[Aragorn] I draw my sword.");
  });

  it("falls back without speaker prefix when speakerName is absent", () => {
    const p = translateRequest(
      req({
        messages: [
          {
            role: "user",
            content: [
              {
                type: "audio",
                source: { kind: "url", url: "https://example.com/clip.wav" },
                transcript: "Just text, no speaker.",
              },
            ],
          },
        ],
      }),
      CFG,
    );
    const block = p.messages[0]?.content as Array<{ type: string; text?: string }>;
    expect(block[0]?.text).toBe("Just text, no speaker.");
  });

  it("throws TranslationError when audio has no transcript", async () => {
    const { TranslationError } = await import("./translate_error.js");
    expect(() =>
      translateRequest(
        req({
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "audio",
                  source: { kind: "base64", mediaType: "audio/ogg", data: "AAAA" },
                },
              ],
            },
          ],
        }),
        CFG,
      ),
    ).toThrow(TranslationError);
  });

  it("throws when audio.transcript is the empty string", async () => {
    const { TranslationError } = await import("./translate_error.js");
    expect(() =>
      translateRequest(
        req({
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "audio",
                  source: { kind: "base64", mediaType: "audio/wav", data: "AAAA" },
                  transcript: "",
                },
              ],
            },
          ],
        }),
        CFG,
      ),
    ).toThrow(TranslationError);
  });
});

describe("translateRequest — messages and tool_result content", () => {
  it("translates tool_result blocks including isError", () => {
    const p = translateRequest(
      req({
        messages: [
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                toolUseId: "tu_1",
                content: "applied 5 damage",
                isError: false,
              },
            ],
          },
        ],
      }),
      CFG,
    );
    const block = p.messages[0]?.content as Array<{
      type: string;
      tool_use_id?: string;
      is_error?: boolean;
    }>;
    expect(block[0]?.type).toBe("tool_result");
    expect(block[0]?.tool_use_id).toBe("tu_1");
    expect(block[0]?.is_error).toBe(false);
  });
});
