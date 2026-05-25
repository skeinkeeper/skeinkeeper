# TDD 0009: Behavior Spec Loader (Phase 1.6)
Status: implemented
PRD refs: 4.3, 6
PRD-rev: 10391ba
ADR constraints: 0006, 0009, 0013
Author: maintainers
Date: 2026-05-19
Related TDDs: [0004 (eval harness)](./0004-eval-harness.md), [0008 (LLM provider interface)](./0008-llm-provider-interface.md)

## Approach

Per [ADR-0006](../adr/0006-behavior-spec-separate-doc.md) the AI DM's behavior is captured in `/behavior/default.md`, versioned independently of the surrounding code, and loaded as the primary system prompt at session start. Phases 1.5a/b/c built the LLMProvider interface and the eval harness's `OrchestratorRunner`, but the runner's system prompt today is a placeholder:

```ts
return fixture.behaviorSpecVersion
  ? `[Skeinkeeper behavior spec ${fixture.behaviorSpecVersion}; loader lands in Phase 1.6]`
  : `[Skeinkeeper behavior spec placeholder; loader lands in Phase 1.6]`;
```

Phase 1.6 replaces that placeholder with a real loader that reads `behavior/default.md`, extracts its version, and verifies the loaded version matches the campaign's `behavior_spec_version`. After this phase, eval fixtures and the live orchestrator can both drive the real behavior spec.

## Components & interfaces

### Loader API

```ts
// orchestrator/src/behavior.ts

export interface BehaviorSpec {
  /** The full markdown content; sent as system prompt verbatim. */
  content: string;
  /** Parsed from the spec's header, e.g., "v0.1". */
  version: string;
  /** Absolute path the spec was loaded from. */
  path: string;
}

export class BehaviorSpecError extends Error {
  constructor(message: string, readonly path: string);
}

/** Synchronous loader. Reads the markdown, parses the version, returns the spec. */
export function loadBehaviorSpec(path: string): BehaviorSpec;

/** Throws BehaviorSpecError when the loaded version doesn't match the
 *  campaign's stored `behavior_spec_version`. Exact-match for Phase 1.6;
 *  semver-ish range matching is deferred. */
export function assertSpecCompatible(
  spec: BehaviorSpec,
  campaignVersion: string,
): void;

/** Walk up from `startDir` looking for `behavior/default.md`. Throws if
 *  no candidate is found before reaching `/`. Useful for tests and the
 *  eval harness, which know they're somewhere inside the repo. */
export function findDefaultBehaviorSpec(startDir: string): string;
```

### Spec file format

For Phase 1.6, the spec is plain markdown with no required structural conventions beyond:

- The first ~500 bytes contain a version line of the shape `**v<MAJOR>.<MINOR>**` (optionally followed by a status tag like `(Draft)` or surrounding text). The loader uses regex `/\*\*v(\d+\.\d+)/`.
- Everything else is freeform markdown sent to the LLM verbatim.

The current `behavior/default.md` line 2 (`**v0.1 (Draft) · Loaded as primary system prompt context for the AI DM**`) matches this pattern; no spec changes are required.

### Path resolution

Three call sites, three patterns:

1. **Operator config (Phase 2+ production)** — the operator passes an absolute path via env var `SKEINKEEPER_BEHAVIOR_SPEC_PATH` or config file. The orchestrator's bootstrap reads it and calls `loadBehaviorSpec(path)`.
2. **Eval harness (this phase)** — the CLI computes the path once via `findDefaultBehaviorSpec(import.meta.dirname)` and reuses it across fixtures.
3. **Unit tests** — pass paths to test fixtures directly.

We deliberately do NOT bake the path into the orchestrator (no hardcoded `../behavior/default.md`). The orchestrator is a library; the caller knows where the spec lives.

### Compatibility checking

Each `Campaign` row has a `behavior_spec_version` field (currently `v0.1`). When a session starts, the orchestrator:

1. Loads the configured spec via `loadBehaviorSpec(path)`.
2. Calls `assertSpecCompatible(spec, campaign.behaviorSpecVersion)`.
3. If mismatched, throws a `BehaviorSpecError` with a clear message naming both versions and the path.

For Phase 1.6, "compatible" means exact-string match. Phase 2+ may relax this — e.g., allow MINOR bumps but block MAJOR — but a strict check is the safest default for behavior-altering changes.

### Where the spec content ends up

The loaded `spec.content` is passed as `LLMRequest.systemPrompt` (per [design doc 0008](./0008-llm-provider-interface.md) § Interface). Prompt caching applies automatically — the spec is stable for a session, so cache hits across turns. No additional wrapping or templating; the spec is self-describing (its §0 explains its own purpose to the model).

### Eval harness integration

Fixtures gain a new optional field:

```yaml
behavior_spec: default      # uses behavior/default.md
# or:
behavior_spec: { inline: "You are a test DM. Respond with..." }
# or omit entirely:
# (uses the placeholder string the runner has today; fast for harness-only smoke tests)
```

The `OrchestratorRunner` checks `fixture.behaviorSpec`:

- `default` → load via `findDefaultBehaviorSpec` + `loadBehaviorSpec`, verify version matches `fixture.behavior_spec_version` if set.
- `{ inline: "..." }` → use the inline string directly; no version check.
- absent → keep today's placeholder (fast harness self-test; new behavior fixtures opt in explicitly).

### Telemetry

One new event:

```ts
"behavior_spec.loaded": {
  v: 1,
  description: "A Behavior Spec was loaded for a session.",
  props: {} as {
    version: string;     // e.g., "v0.1"
    sizeKbBucket: string; // "<5", "<15", "<50", ">=50"
  },
}
```

The version field reveals which spec version is in use across opted-in operators — useful for the maintainers tracking adoption of new spec releases. The size bucket guards against spec bloat without revealing content.

## Data & state

Covered under Approach.

## Sequencing / implementation plan

Covered under Approach.

## Failure modes & edge cases

Covered under Approach.

## Requirement traceability

| PRD ref | Requirement | Satisfied by |
|---------|-------------|--------------|
| 4.3 | Behavior is spec, not code — loaded as system prompt | `loadBehaviorSpec` reads `behavior/default.md` and returns its full content as `BehaviorSpec.content`, passed verbatim as `LLMRequest.systemPrompt` |
| 4.3 | Behavior spec iterates independently of platform code | spec is versioned markdown loaded by path; `assertSpecCompatible` enforces version agreement between spec-on-disk and `campaign.behavior_spec_version` |
| 6 | Architecture principle #4: Behavior is spec, not code | loader is a library function (not hardcoded path); the orchestrator receives content from the caller, not from an internal constant |

## Dependencies considered

None — no new third-party dependency introduced by this design.

## PRD conflicts surfaced (and resolution)

None — this design directly implements ADR-0006 (behavior spec as separate doc) and is consistent with ADR-0009 (telemetry opt-in). No PRD requirement proved infeasible or contradictory.

## Decisions to promote (ADR candidates)

None — the durable decision here is already captured in ADR-0006 (behavior spec as a versioned, separately-loaded markdown file).

## Alternatives considered

- **YAML/JSON frontmatter** for the version metadata. Cleaner parse, but the spec is written for human authors first; mandating a machine-readable header introduces friction for the most-edited file in the repo. The single-regex parse is fine.
- **A separate `version.txt`** alongside the spec. Two files to keep in sync; error-prone.
- **Behavior spec as TypeScript module** (`export const spec = "..."`). Loses the "edit a markdown file" UX that ADR-0006 explicitly defended. Rejected.
- **Async loader** returning `Promise<BehaviorSpec>`. The file is ~12KB and loaded once per session — sync is fine, and sync simplifies the orchestrator's session bootstrap path. Phase 2+ can revisit if multi-tenant lazy-loading appears.

## Telemetry implications

One new event: `behavior_spec.loaded` (see Telemetry subsection above under Components & interfaces). The event version and size-bucket fields are anonymous and non-PII.

## Privacy implications

The loaded spec is sent to the configured LLM provider as the system prompt. This is the same data path as any other prompt content (per `docs/PRIVACY.md`). No new PII, no new consents required — the spec is project-authored markdown, not user data.

## Eval implications

- Existing fixtures stay unchanged (`behavior_spec` field is optional; default behavior is the placeholder string).
- One new fixture (`002-behavior-spec-loaded.eval.yaml`) opts into `behavior_spec: default` and asserts that the FakeLLMProvider's request carried the real spec. Provides a regression check that the loader-to-runner-to-provider path is wired correctly.
- The integration test in `plugins/llm-anthropic/` (gated by `ANTHROPIC_API_KEY`) is unchanged for this phase — it uses a synthetic system prompt; a behavior-spec-driven integration test lands when there's enough infrastructure to make it meaningful (Phase 2+).

## Open questions

- **Section-level retrieval.** §0 of the spec mentions "Sections are also embedded for retrieval; relevant guidance is pulled into hot context based on the current situation." That's a Phase 4+ optimization (cold-tier work). For Phase 1.6 we send the full ~12KB spec on every turn — prompt caching makes this cheap.
- **Overlays.** §1 mentions operator-selected personality presets that overlay the default spec. Phase 5+ feature; the loader API is small enough that adding overlay support later won't require breaking changes.
- **Multi-locale specs.** No current need; the loader takes a path, so an operator could maintain multiple spec files at different paths and pick which to load.
