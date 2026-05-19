# Design Doc 0004: Eval Harness

> Status: Accepted
> Author: maintainers
> Date: 2026-05-19
> Related ADRs: [ADR-0006 (behavior spec)](../adr/0006-behavior-spec-separate-doc.md)

## Context

The AI DM's behavior is data, not code — it lives in `/behavior/default.md` and iterates faster than the engine around it. That iteration is only safe if there's a way to detect when a behavior change accidentally regresses an established expectation ("never narrate player character emotions," "always describe three senses on entry to a new location," "never fudge an open roll").

The eval harness is the regression-detection mechanism. It loads scenario fixtures, runs each through the orchestrator (eventually via the configured `LLMProvider`), and checks the response against declarative expectations.

Phase 0.4 lands the framework, not the real runner — the real runner needs the `LLMProvider` from Phase 1.5. This doc covers the contract and the stub that lets CI exercise the framework end-to-end before the LLM is plugged in.

## Decision

### Fixture format

YAML files under `eval/fixtures/*.eval.yaml`. One fixture per file. Schema:

```yaml
name: tavern-three-senses                   # unique within the fixture set
description: |                              # what this scenario tests
  When the party enters a new location, the AI's first beat should reference
  at least one non-sight sense per behavior/default.md §2.1.
behavior_spec_version: v0.1                 # the spec version this expects; advisory
skip: ""                                    # optional reason; non-empty = skip with that reason
scenario:
  state:                                    # initial warm state for the runner
    location: tavern
  turns:                                    # ordered turns to play
    - speaker: player
      text: "We push open the door of the inn."
expectations:                               # checked against the runner's final response
  - kind: not_empty
    field: narration
  - kind: contains_any_of
    field: narration
    texts: [warm, glow, fire, hearth, smoke, sound, smell, taste, cold, damp]
    description: "Should reference at least one non-sight sense"
```

Expectation kinds for v0:

- `not_empty { field }` — the named field exists and has non-empty content.
- `contains { field, text }` — case-insensitive substring match.
- `contains_any_of { field, texts[] }` — at least one of the texts is present.
- `not_contains { field, text }` — substring is absent.
- `regex_match { field, pattern }` — JS regex match.

`field` for now is just `narration`. The schema reserves the field for future targets like `tool_calls[]`, `state.<path>`, `whispers[]`.

Future kinds (deferred): `tool_called`, `tool_not_called`, `state_change`, `roll_was_secret`.

### Runner interface

```ts
export interface RunnerInput {
  fixture: Fixture;
}

export interface RunnerOutput {
  narration: string;
  // Reserved: toolCalls: ReadonlyArray<ToolCall>; stateAfter: ...
}

export interface Runner {
  readonly name: string;
  run(input: RunnerInput): Promise<RunnerOutput>;
}
```

For Phase 0.4 we ship `MockRunner`, which emits a deterministic stub response from the last player turn:

```ts
class MockRunner implements Runner {
  readonly name = "mock";
  async run({ fixture }): Promise<RunnerOutput> {
    const last = [...fixture.scenario.turns].reverse().find((t) => t.speaker === "player");
    return { narration: `[stub narration in response to: ${last?.text ?? "(no input)"}]` };
  }
}
```

Phase 1.5 swaps `MockRunner` for an `OrchestratorRunner` that wires the real `LLMProvider`. Fixtures stay the same.

### Reporter

For each fixture × expectation, the reporter records `pass | fail | skipped`. Output is a structured `EvalReport`:

```ts
interface EvalReport {
  fixtures: ReadonlyArray<{
    name: string;
    status: "pass" | "fail" | "skipped";
    reason?: string;
    expectations: ReadonlyArray<{
      kind: string;
      status: "pass" | "fail";
      message?: string;
    }>;
  }>;
  totals: { pass: number; fail: number; skipped: number };
}
```

The CLI prints a human-readable summary and exits non-zero if any expectations failed. The structured report is also written to `eval/last-run.json` so CI can post it as a PR comment.

### CI integration

`.github/workflows/ci.yml` already runs `pnpm eval`. Add a step *after* eval that, when the trigger is a `pull_request`:

- Reads `eval/last-run.json`.
- If `totals.fail > 0`, posts a comment summarizing failures via `gh pr comment $PR_NUMBER --body @-`.
- If `totals.fail == 0`, skips the comment (no need to clutter PRs with "all green" notes).

The comment uses GITHUB_TOKEN; no extra setup. Behavior-only PRs (changes scoped to `behavior/**` or `eval/fixtures/**`) will produce comments most often, which is the intended audience.

### Where it lives

- `eval/` workspace package with `src/`, `fixtures/`, and a `cli.ts` entry point.
- `scripts/run-eval.mjs` (top-level wrapper) is replaced to invoke the eval CLI.

## Alternatives considered

- **JSON fixtures instead of YAML.** YAML wins on multi-line strings (most fixtures will have multi-sentence player turns and rationale).
- **Code-defined fixtures (TypeScript files) instead of declarative YAML.** Rejected: non-engineer contributors (experienced DMs writing fixtures) shouldn't have to learn TypeScript to add a scenario.
- **One unified runner that always hits the real LLM.** Rejected: CI runs every PR; live LLM calls cost money and add latency. The mock-by-default + opt-in-real model keeps CI fast and free.

## Telemetry implications

None at the harness layer. Future runs that hit real LLMs will already be covered by the `tool.called` and `error.captured` events from the orchestrator.

## Privacy implications

Fixtures may contain example player utterances. They're committed to the public repo, so authors must avoid putting real-player data into fixtures. Documented in `eval/fixtures/README.md`.

## Eval implications

(meta) The harness itself doesn't need an eval. The unit tests of the harness verify the loader, reporter, and CLI exit codes.

## Open questions

- **Replay vs live run distinction.** Some fixtures will eventually want to be "replayed" against a recorded LLM response (deterministic, free) vs run live. Add a `mode: replay|live` field when that need lands.
- **Fixture sharding for parallel CI.** Defer; v0.5 if fixture count gets large.
- **Per-fixture LLM model override.** Some fixtures might want to test Opus-only behaviors. Defer; add a `model:` field when needed.
