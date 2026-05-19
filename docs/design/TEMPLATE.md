# Design Doc NNNN: <Title>

> Status: Draft | In Review | Accepted | Implemented | Withdrawn
> Author: <name or handle>
> Date: <YYYY-MM-DD>
> Related ADRs: <list of ADR numbers this design implements or extends>
> Related design docs: <list, if any>

## Context

What's the problem? What forces are at play? What constraints does this design need to respect (existing data model, plugin interfaces, behavior spec, ADRs)?

Keep this section short — link to ADRs and prior design docs for background rather than re-explaining them.

## Decision

What are we going to do? State it as an active assertion. Include enough specificity that a reviewer can tell whether the design is sound _and_ whether the implementation will match it. Code sketches, schema fragments, sequence diagrams, and interface signatures all belong here.

A non-trivial design will usually have:

- The shape of the data (tables, types, payloads)
- The shape of the code (modules, interfaces, public functions)
- The shape of the runtime behavior (control flow, error handling, retries)

## Alternatives considered

What other approaches did you weigh? Why aren't they the chosen one? Briefly is fine — the goal is to show the reader that the chosen approach was picked deliberately, not by default.

If there's only one reasonable approach, say so explicitly rather than inventing alternatives.

## Telemetry implications

What new telemetry events does this design introduce? Each event needs a name, version, payload schema, and a one-line description. Add the events to `/telemetry/src/events.ts` and `/docs/telemetry-events.md` as part of implementation.

If the design touches existing events (changes payload shape, retires an event), call that out — event schemas are versioned per ADR-0009.

If the feature emits no telemetry, write "None" and explain why.

## Privacy implications

For any feature that touches personal data, answer:

- **Lawful basis (if applicable to operator's jurisdiction):** what permits processing this data? Consent (with consent record), legitimate interest, contractual necessity?
- **PII handling:** which fields carry the `PII<T>` type marker? Are they encrypted at rest? Logged anywhere they shouldn't be?
- **Deletion path:** when an operator runs `skeinkeeper player:delete <id>` or `campaign:delete <id>`, what cascades? Add a deletion adapter under the central `ErasureService` per ADR-0010.
- **Consent (if voice/audio):** does the existing per-player voice consent cover this, or do we need a new purpose in the `consents` table?

If the feature doesn't touch personal data, write "None" and explain why.

## Eval implications

What scenario fixtures need to exist before this design ships? What does success look like — measurably?

If the feature is mechanical (no LLM behavior), unit tests are likely sufficient — say so. If the feature shapes what the AI DM does, fixtures in `/eval/fixtures/` exercising the new behavior are required per CLAUDE.md hard rule #10.

## Open questions

What did you not resolve in this doc that the reviewer needs to weigh in on, or that's intentionally deferred to implementation? Each question should be actionable — "what's the retry policy for tool calls?" not "is this the right approach?".
