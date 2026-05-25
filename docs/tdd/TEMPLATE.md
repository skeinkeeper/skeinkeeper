# TDD NNNN: <feature>
Status: draft | ready | implemented
PRD refs: <PRD requirement/section numbers this design satisfies, e.g. 4.1, 5.3>
PRD-rev: <git short SHA of docs/PRD.md at authoring time>
ADR constraints: <accepted ADR numbers this design respects, e.g. 0003, 0018>

<!--
Authoring notes:
- Status is one of: draft (being written) / ready (approved to build) / implemented
  (built, verified, reviewed).
- The Status line MUST be a plain line (not a blockquote), and the frontmatter fields
  above must stay machine-readable (plain `Key: value` lines, in this order).
- Keep the WHAT in docs/PRD.md; this doc is the HOW.
-->

## Approach
The chosen design, stated as an active assertion, with the context/forces that shape it.
Link to ADRs and prior TDDs for background rather than re-explaining them.

## Components & interfaces
Modules, public functions, interface signatures, who calls whom.

## Data & state
Tables, types, payloads, what is owned where. (Mechanical game state lives in Foundry per
ADR-0018; only AI-DM state lives in Skeinkeeper SQLite.)

## Sequencing / implementation plan
The order of work; the steps an implementer follows.

## Failure modes & edge cases
What can go wrong, how it's handled, what degrades gracefully.

## Requirement traceability
Each PRD requirement (FR/NFR) in scope → the design element that satisfies it. Call out gaps.

| PRD ref | Requirement | Satisfied by |
|---------|-------------|--------------|
|         |             |              |

## Dependencies considered
REQUIRED for every new dependency (library/framework/service/integration): the chosen option
plus ≥1 concrete rejected alternative and a one-line reason (licensing, cost, maintenance,
lock-in). Prefer OSS/self-hostable. If no new dependency, write "None." (per CLAUDE.md hard
rule #10).

## PRD conflicts surfaced (and resolution)
Infeasible, contradictory, or under-specified PRD requirements found while designing, and how
they were resolved (or "None").

## Decisions to promote (ADR candidates)
Durable, cross-cutting decisions in this design that should become ADRs (or "None" /
"promoted to ADR-NNNN").

<!-- Repo-specific retained sections — Skeinkeeper requires these on every TDD that
     touches telemetry, personal data, or AI-DM behavior (see CLAUDE.md hard rules #3, #8, #12). -->

## Telemetry implications
New/changed telemetry events (name, version, payload, one-line description), added to
`/telemetry/src/events.ts` and `/docs/telemetry-events.md`. "None" + why, if none.

## Privacy implications
Lawful basis, PII handling (`PII<T>` marker, encryption per ADR-0019), deletion path
(`DeletionAdapter` per ADR-0010), and consent for any new personal-data processing. "None" + why.

## Eval implications
Scenario fixtures required before this ships, and the measurable success bar. "None" + why, for
mechanical (non-LLM) features.
