// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineTool } from "./registry.js";
import { toolDefinitionToLlmSpec } from "./tool_definition_to_spec.js";

const sampleTool = defineTool({
  name: "apply_damage",
  description: "Apply damage to a character.",
  inputSchema: z.object({
    characterId: z.string(),
    amount: z.number().int().min(1).max(999),
    source: z.string().optional(),
  }),
  outputSchema: z.object({ characterId: z.string(), before: z.number(), after: z.number() }),
  async handle(input) {
    return { characterId: input.characterId, before: 0, after: -input.amount };
  },
});

describe("toolDefinitionToLlmSpec", () => {
  it("preserves the tool name and description", () => {
    const spec = toolDefinitionToLlmSpec(sampleTool);
    expect(spec.name).toBe("apply_damage");
    expect(spec.description).toBe("Apply damage to a character.");
  });

  it("produces a JSON Schema with the right field types", () => {
    const spec = toolDefinitionToLlmSpec(sampleTool);
    const props = (spec.inputSchemaJson as { properties: Record<string, { type: string }> })
      .properties;
    expect(props.characterId?.type).toBe("string");
    expect(props.amount?.type).toBe("integer");
    expect(props.source?.type).toBe("string");
  });

  it("marks required vs optional fields correctly", () => {
    const spec = toolDefinitionToLlmSpec(sampleTool);
    const required = (spec.inputSchemaJson as { required?: string[] }).required ?? [];
    expect(required).toContain("characterId");
    expect(required).toContain("amount");
    expect(required).not.toContain("source");
  });

  it("strips the $schema JSON Schema URI from the output", () => {
    const spec = toolDefinitionToLlmSpec(sampleTool);
    expect(spec.inputSchemaJson).not.toHaveProperty("$schema");
  });

  it("declares the root schema as an object", () => {
    const spec = toolDefinitionToLlmSpec(sampleTool);
    expect((spec.inputSchemaJson as { type: string }).type).toBe("object");
  });
});
