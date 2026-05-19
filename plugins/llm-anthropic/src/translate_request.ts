// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import type Anthropic from "@anthropic-ai/sdk";
import type {
  BetaMessageStreamParams,
  BetaOutputConfig,
} from "@anthropic-ai/sdk/resources/beta/messages";
import type {
  Effort,
  LLMContent,
  LLMMessage,
  LLMRequest,
  LLMToolSpec,
} from "@skeinkeeper/orchestrator";
import { TranslationError } from "./translate_error.js";

export interface RequestTranslationConfig {
  modelNarration: string;
  modelOrchestration: string;
  defaultEffortNarration: Effort;
  defaultEffortOrchestration: Effort;
  defaultMaxTokens: number;
}

/**
 * Translate a provider-neutral LLMRequest into the Anthropic SDK's streaming
 * params shape. Pure function; testable without the SDK or network.
 *
 * Per design doc 0008 § "Decision."
 */
export function translateRequest(
  req: LLMRequest,
  cfg: RequestTranslationConfig,
): BetaMessageStreamParams {
  const model =
    req.modelTier === "narration" ? cfg.modelNarration : cfg.modelOrchestration;
  // Effort and adaptive thinking are not supported on Haiku 4.5 / Sonnet 4.5
  // (API returns 400 "this model does not support the effort parameter").
  // Both are accepted on Opus 4.5/4.6/4.7 and Sonnet 4.6.
  const supportsEffort =
    model.startsWith("claude-opus-4-5") ||
    model.startsWith("claude-opus-4-6") ||
    model.startsWith("claude-opus-4-7") ||
    model.startsWith("claude-sonnet-4-6");
  const supportsAdaptiveThinking = supportsEffort;
  const isOpus47 = model.startsWith("claude-opus-4-7");

  const effort =
    req.effort ??
    (req.modelTier === "narration"
      ? cfg.defaultEffortNarration
      : cfg.defaultEffortOrchestration);

  const params: BetaMessageStreamParams = {
    model: model as BetaMessageStreamParams["model"],
    max_tokens: req.maxTokens ?? cfg.defaultMaxTokens,
    system: translateSystem(req.systemPrompt, req.cacheSystemPrompt ?? true),
    messages: req.messages.map(translateMessage),
    ...(req.tools.length > 0 ? { tools: translateTools(req.tools) } : {}),
  };

  if (supportsEffort) {
    params.output_config = { effort };
  }

  if (supportsAdaptiveThinking) {
    params.thinking = { type: "adaptive", display: "summarized" };
  }

  if (req.taskBudgetTokens && isOpus47) {
    // `task_budget` lives in BetaOutputConfig but the base output_config type
    // accepts pass-through fields at runtime under the task-budgets beta.
    const oc: BetaOutputConfig = (params.output_config ?? {}) as BetaOutputConfig;
    oc.task_budget = { type: "tokens", total: req.taskBudgetTokens };
    params.output_config = oc;
  }

  return params;
}

function translateSystem(
  prompt: string,
  cache: boolean,
): Anthropic.Messages.TextBlockParam[] {
  const block: Anthropic.Messages.TextBlockParam = { type: "text", text: prompt };
  if (cache) block.cache_control = { type: "ephemeral" };
  return [block];
}

function translateTools(
  tools: ReadonlyArray<LLMToolSpec>,
): Anthropic.Messages.ToolUnion[] {
  return tools.map((t, i) => {
    const tool: Anthropic.Messages.Tool = {
      name: t.name,
      description: t.description,
      input_schema: t.inputSchemaJson as Anthropic.Messages.Tool.InputSchema,
    };
    if (i === tools.length - 1) {
      // Cache the tool list as a unit by setting cache_control on the
      // terminating tool (per Anthropic prompt-caching docs).
      tool.cache_control = { type: "ephemeral" };
    }
    return tool;
  });
}

function translateMessage(msg: LLMMessage): Anthropic.Messages.MessageParam {
  return {
    role: msg.role,
    content: msg.content.map(translateContent),
  };
}

function translateContent(c: LLMContent): Anthropic.Messages.ContentBlockParam {
  switch (c.type) {
    case "text":
      return { type: "text", text: c.text };
    case "tool_use":
      return { type: "tool_use", id: c.id, name: c.name, input: c.input };
    case "tool_result": {
      const block: Anthropic.Messages.ToolResultBlockParam = {
        type: "tool_result",
        tool_use_id: c.toolUseId,
        content: c.content,
      };
      if (c.isError !== undefined) block.is_error = c.isError;
      return block;
    }
    case "compaction":
      // Compaction blocks are beta and not in the typed ContentBlockParam
      // union. Round-trip the opaque payload verbatim.
      return c.opaque as Anthropic.Messages.ContentBlockParam;
    case "audio": {
      // Anthropic's Messages API doesn't accept audio input (verified
      // against platform.claude.com docs, 2026-05-19). Per design doc
      // 0010 we fall back to the pre-computed transcript when present
      // and reject explicitly when it isn't.
      if (c.transcript === undefined || c.transcript.length === 0) {
        throw new TranslationError(
          "Audio content provided without a transcript, but Claude's Messages API doesn't accept audio. " +
            "Either set audio.transcript (e.g., from your STT layer) or configure an audio-native LLM provider.",
        );
      }
      const prefix = c.speakerName ? `[${c.speakerName}] ` : "";
      return { type: "text", text: prefix + c.transcript };
    }
  }
}
