// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { zodToJsonSchema } from "zod-to-json-schema";
import type { AnyToolDefinition } from "./registry.js";
import type { LLMToolSpec } from "./interfaces/llm.js";

/**
 * Convert a Zod-typed `ToolDefinition` to a provider-agnostic `LLMToolSpec`
 * (with JSON Schema input). Called once per session at the orchestrator-↔-
 * provider boundary; runtime validation against the original Zod schema
 * continues to happen inside the ToolDispatcher.
 *
 * Per design doc 0008 § "Tool use."
 */
export function toolDefinitionToLlmSpec(td: AnyToolDefinition): LLMToolSpec {
  const schema = zodToJsonSchema(td.inputSchema, {
    target: "openApi3",
    $refStrategy: "none",
  }) as Record<string, unknown>;
  // zod-to-json-schema may attach a `$schema` URI; Anthropic's input_schema
  // field rejects it. Strip if present.
  delete schema["$schema"];
  return {
    name: td.name,
    description: td.description,
    inputSchemaJson: schema,
  };
}
