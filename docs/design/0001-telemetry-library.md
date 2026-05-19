# Design Doc 0001: Telemetry Library

> Status: Accepted
> Author: maintainers
> Date: 2026-05-18
> Related ADRs: [ADR-0009 (telemetry opt-in)](../adr/0009-telemetry-opt-in.md), [ADR-0010 (privacy as architecture)](../adr/0010-privacy-as-architecture.md)

## Context

ADR-0009 commits Skeinkeeper to two telemetry streams that default to off and can only ever send data after the operator opts in. The plumbing has to exist from day one so that (a) every user-visible feature can declare its telemetry events as part of the feature PR, and (b) the registry is the only legitimate emission surface — direct PostHog or Sentry calls anywhere else in the codebase are a bug.

The library has to satisfy four constraints simultaneously:

1. **Default-disabled, verified by test.** A fresh install with no env vars set must send zero bytes anywhere.
2. **Type-level rejection of PII** in the analytics stream. The codebase already has a `PII<T>` brand from the privacy foundation (Task 0.6). The analytics client must refuse, at the type level, to accept event payloads that carry `PII<T>` fields. This is structural, not a code-review check.
3. **Versioned, documented event registry.** Every event has a name, a major-version integer, and a one-line description. CI fails if any event in the registry has no doc entry in `docs/telemetry-events.md` or vice versa.
4. **Single emission surface.** ESLint flags any `import` of `posthog-node` or `@sentry/*` outside `telemetry/src/`. The orchestrator, plugins, web, etc. all go through the typed `telemetry` package.

## Decision

A `telemetry` workspace package with this surface:

```ts
// telemetry/src/types.ts
declare const piiBrand: unique symbol;
export type PII<T> = T & { readonly [piiBrand]: true };

// NoPII rejects any property typed as PII<T> at the type level.
// Keys are deeply checked so nested structures can't smuggle PII through.
export type NoPII<T> =
  T extends PII<unknown> ? never : T extends object ? { [K in keyof T]: NoPII<T[K]> } : T;

export type EventName = `${string}.${string}`; // namespace.event
export interface EventDef<Props> {
  readonly v: number; // major version, integer ≥ 1
  readonly description: string; // human-readable, ≥ 10 chars
  readonly props: Props; // phantom carrier of the props type
}

export type EventRegistry = Readonly<Record<EventName, EventDef<unknown>>>;
```

```ts
// telemetry/src/events.ts — the canonical registry
import type { EventRegistry } from "./types.js";

export const events = {
  "app.started": {
    v: 1,
    description: "Skeinkeeper process started.",
    props: {} as { version: string; nodeVersion: string },
  },
  "session.started": {
    v: 1,
    description: "An RPG session began.",
    props: {} as { campaignIdHash: string; rulesetId: string },
  },
  "session.ended": {
    v: 1,
    description: "An RPG session ended.",
    props: {} as { campaignIdHash: string; durationSecBucket: string; turnCount: number },
  },
  "tool.called": {
    v: 1,
    description: "A typed tool was invoked by the orchestrator.",
    props: {} as { toolName: string; success: boolean; latencyMsBucket: string },
  },
  "error.captured": {
    v: 1,
    description: "An unexpected error was captured for crash reporting.",
    props: {} as { errorClass: string; module: string },
  },
} as const satisfies EventRegistry;
```

```ts
// telemetry/src/analytics.ts
import type { events } from "./events.js";
import type { NoPII } from "./types.js";

type Events = typeof events;

// track() takes a registered event name and a payload whose shape matches
// the event's declared props *and* contains no PII<T> fields. Both
// constraints are enforced at compile time; there is no runtime PII
// scrubbing because at this layer the type system has already said no.
export interface AnalyticsClient {
  track<N extends keyof Events>(name: N, props: NoPII<Events[N]["props"]>): void;
  flush(): Promise<void>;
}

export interface AnalyticsConfig {
  enabled: boolean; // sourced from env at app boot
  posthogKey?: string;
  posthogHost?: string;
  installationId: string; // opaque rotating token; never PII
}

export function createAnalytics(config: AnalyticsConfig): AnalyticsClient {
  if (!config.enabled || !config.posthogKey) return noopAnalytics();
  // ...wraps posthog-node, only constructed when enabled
}
```

```ts
// telemetry/src/crash.ts
export interface CrashClient {
  captureError(err: unknown, context?: { module?: string; sessionId?: string }): void;
  flush(): Promise<void>;
}

export interface CrashConfig {
  enabled: boolean;
  sentryDsn?: string;
  installationId: string;
}

export function createCrash(config: CrashConfig): CrashClient {
  if (!config.enabled || !config.sentryDsn) return noopCrash();
  // ...wraps @sentry/node, only constructed when enabled
}
```

**Boot wiring.** The local server reads `SKEINKEEPER_TELEMETRY_ANALYTICS` and `SKEINKEEPER_TELEMETRY_CRASH` at startup. Either set to the literal string `"1"` enables that stream; any other value (including unset, empty, `"0"`, `"true"`) keeps it disabled. The strict gate is deliberate: typos default safe.

**Installation ID.** An opaque random UUID generated on first run, persisted to the local data directory. Rotates on `skeinkeeper telemetry:rotate-id` (alpha-acceptable: not strictly required at alpha; web UI exposes a rotate button in v0.5). Never derived from operator identity; never sent unless the corresponding stream is enabled.

**Self-tests** verify three behaviors:

1. **Default-off contract.** `createAnalytics({ enabled: false, ... })` → calling `track(...)` performs zero side effects. Verified by mocking the PostHog SDK's `capture()` and asserting it's never called.
2. **Opt-in emission.** With `enabled: true` and a stubbed SDK, `track(...)` results in exactly one `capture()` call whose payload matches the input.
3. **Type-level PII rejection.** A TypeScript test file uses `expectError`/`@ts-expect-error` to assert that `track("session.started", { campaignIdHash: brandPII("foo") })` fails to compile when `campaignIdHash` is `PII<string>`.

**Lint enforcement.** `no-restricted-imports` already blocks `posthog-node` and `@sentry/*` outside `telemetry/src/`. The Task-0.1 ESLint config grandfathers `telemetry/src/**` as the one place where the underlying SDKs may be imported.

**Registry CI validation** (`scripts/validate-telemetry-events.mjs`):

- Imports `events.ts` dynamically.
- For each event: `description` is a string ≥ 10 chars; `v` is an integer ≥ 1; the event name matches `${string}.${string}`.
- Asserts every event name has a corresponding section heading in `docs/telemetry-events.md` and vice versa.

## Alternatives considered

- **Direct PostHog/Sentry calls** anywhere in the codebase. Rejected: violates ADR-0009's "single emission surface" rule and would let PII slip in via the back door.
- **Runtime PII scrubbing** instead of type-level rejection. Rejected: scrubbing requires inferring intent, which is fragile and can fail silently. Type-level rejection makes the constraint explicit at the call site.
- **One unified telemetry stream** instead of two (analytics + crash). Rejected by ADR-0009: the two streams have meaningfully different consent stories. Crash reports may carry stack traces with local file paths or variable names that count as identifying in a way pure analytics doesn't.
- **OpenTelemetry as the transport.** Rejected for alpha: heavier dependency and no immediate benefit since the only sinks are PostHog and Sentry. Revisit when a third sink emerges.

## Telemetry implications

This design _is_ the telemetry library. The five starter events (`app.started`, `session.started`, `session.ended`, `tool.called`, `error.captured`) seed the registry. Subsequent features add their own events as part of their PRs.

## Privacy implications

- **Lawful basis:** for OSS, the operator runs the software themselves and explicitly enables telemetry; that's the consent. No lawful-basis decision is delegated to the project per ADR-0010.
- **PII handling:** the analytics stream rejects `PII<T>` fields at compile time. The crash stream may carry incidental PII in stack traces; Sentry's data-scrubbing configuration is enabled and documented.
- **Deletion path:** the only persistent local state from telemetry is the installation ID. The deletion adapter (Task 0.7) drops it on full-instance erasure. Per-player deletion does not affect telemetry state because telemetry payloads carry no player identity.
- **Consent:** not voice-related; no `consents` table changes needed for the telemetry library itself. The operator-level enable/disable lives in the web UI (Settings → Telemetry, v0.5) with a config-flag fallback at alpha.

## Eval implications

No behavioral evals required — this is mechanical infrastructure. Unit tests cover the three contract behaviors above.

## Open questions

- **Sampling.** Should `tool.called` sample at high call rates (e.g., 1-in-10) to bound payload volume? Probably yes long term; defer until a real session generates representative data.
- **Cost dashboard wiring.** A future local cost dashboard will need LLM/TTS/STT usage events. Those are operator-visible local-only metrics, not telemetry sends — design that separately under `server/cost-tracking/` later. This design doc explicitly scopes only the maintainer-facing two-stream telemetry library.
- **Installation-ID rotation UX.** Whether to surface this in the alpha config flag or wait for the v0.5 web UI. Defer to web-UI design.
