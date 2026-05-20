// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import type { LLMProvider, LLMRequest } from "@skeinkeeper/orchestrator";
import {
  assertSpecCompatible,
  createDefaultRegistry,
  findDefaultBehaviorSpec,
  loadBehaviorSpec,
  MockFoundryClient,
  ToolDispatcher,
  toolDefinitionToLlmSpec,
} from "@skeinkeeper/orchestrator";
import { openDb, TenantDb, schema } from "@skeinkeeper/server";
import type { Fixture, Turn } from "./fixture.js";
import type { Runner, RunnerInput, RunnerOutput, ToolCallRecord } from "./runner.js";

/**
 * Eval-harness runner. Drives an injected LLMProvider (a FakeLLMProvider
 * scripted by the fixture's `llm_script`) to capture the model's narration +
 * tool calls, then **dispatches those tool calls through the real tool
 * registry** so a `tool_called` expectation reflects an actually-dispatchable
 * tool — not merely one the script named. This catches tool renames/removals,
 * operator-gating, and bad inputs that the old echo-only runner could not.
 *
 * The model itself is faked (deterministic, CI-safe). Behavior-spec / model
 * quality is validated by live playtest and a future `eval:live` path, not here
 * — see eval/fixtures/README.md.
 */
export class OrchestratorRunner implements Runner {
  readonly name = "orchestrator";

  constructor(private readonly llm: LLMProvider) {}

  async run({ fixture }: RunnerInput): Promise<RunnerOutput> {
    const req: LLMRequest = {
      systemPrompt: buildSystemPrompt(fixture),
      messages: buildMessages(fixture.scenario.turns),
      // Real tool specs so a live model (eval:live) can actually call them; the
      // scripted FakeLLMProvider ignores them.
      tools: createDefaultRegistry().list().map(toolDefinitionToLlmSpec),
      modelTier: "narration",
    };

    let narration = "";
    const emitted: Array<{ id: string; name: string; input: unknown }> = [];

    for await (const ev of this.llm.complete(req)) {
      if (ev.kind === "text_delta") {
        narration += ev.text;
      } else if (ev.kind === "tool_call") {
        emitted.push({ id: ev.id, name: ev.name, input: ev.input });
      } else if (ev.kind === "error") {
        break;
      }
    }

    const toolCalls = await dispatchEmitted(emitted);
    return { narration, toolCalls };
  }
}

/**
 * Dispatch the model's emitted tool calls against the real default registry,
 * recording success/failure. State-mutating tools reference a campaignId in
 * their input, so we seed those campaign rows; the dispatch is otherwise
 * against an in-memory DB + mock Foundry.
 */
async function dispatchEmitted(
  emitted: ReadonlyArray<{ id: string; name: string; input: unknown }>,
): Promise<ToolCallRecord[]> {
  if (emitted.length === 0) return [];

  const db = openDb({ path: ":memory:", runMigrations: true });
  try {
    const now = Date.now();
    db.insert(schema.tenants).values({ id: "default", name: "eval", createdAt: now }).run();
    for (const id of campaignIdsFrom(emitted)) {
      db.insert(schema.campaigns)
        .values({
          id,
          tenantId: "default",
          name: id,
          rulesetId: "dnd5e",
          behaviorSpecVersion: "v0.1",
          status: "active",
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing()
        .run();
    }
    const tenantDb = new TenantDb(db, "default");
    const dispatcher = new ToolDispatcher({ registry: createDefaultRegistry() });
    const ctx = {
      tenantDb,
      sessionId: "eval",
      turnId: "eval",
      caller: "llm" as const,
      foundry: new MockFoundryClient({ system: "dnd5e" }),
    };

    const out: ToolCallRecord[] = [];
    for (const tc of emitted) {
      const result = await dispatcher.dispatch({ name: tc.name, input: tc.input }, ctx);
      out.push({ id: tc.id, name: tc.name, input: tc.input, ok: result.ok });
    }
    return out;
  } finally {
    db.close();
  }
}

function campaignIdsFrom(
  emitted: ReadonlyArray<{ input: unknown }>,
): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const tc of emitted) {
    const cid = (tc.input as { campaignId?: unknown } | null)?.campaignId;
    if (typeof cid === "string" && cid.length > 0) ids.add(cid);
  }
  return ids;
}

function buildSystemPrompt(fixture: Fixture): string {
  // Per design doc 0009: fixtures opt-in to the real spec via
  // `behavior_spec: default` (load behavior/default.md) or
  // `behavior_spec: { inline: "..." }` (use the literal string). Omitting
  // the field keeps the placeholder for fast harness-only smoke tests.
  if (fixture.behaviorSpec === "default") {
    const path = findDefaultBehaviorSpec(import.meta.dirname);
    const spec = loadBehaviorSpec(path);
    if (fixture.behaviorSpecVersion) {
      assertSpecCompatible(spec, fixture.behaviorSpecVersion);
    }
    return spec.content;
  }
  if (fixture.behaviorSpec && typeof fixture.behaviorSpec === "object") {
    return fixture.behaviorSpec.inline;
  }
  return fixture.behaviorSpecVersion
    ? `[Skeinkeeper behavior spec ${fixture.behaviorSpecVersion}; load via behavior_spec:default to use the real spec]`
    : `[Skeinkeeper behavior spec placeholder; set behavior_spec:default to load behavior/default.md]`;
}

function buildMessages(turns: ReadonlyArray<Turn>): LLMRequest["messages"] {
  const text = turns.map((t) => `[${t.speaker}] ${t.text}`).join("\n");
  return [{ role: "user", content: [{ type: "text", text }] }];
}
