# ADR-0006: DM Behavior Spec Lives in a Separately-Versioned Document

## Status
Proposed (2026-05-17)

## Context

There are two very different categories of decision in this project:

- **Product/architectural decisions** — what capabilities the platform offers, what the data model is, what the plugin boundaries look like. These change rarely and require coordination across the codebase.
- **DM behavioral decisions** — how the AI narrates, when it calls for rolls, whether it fudges, what NPCs sound like, how it manages pacing. These change frequently — likely weekly during active play — and require no code change, only prompt/spec adjustments.

Conflating these into a single document creates two problems:

1. The product doc churns whenever someone tunes the AI's voice, making the change history noisy and the doc unstable as a reference.
2. The behavior doc gets reviewed with engineering rigor (slow, formal) when it actually wants the iteration cadence of a style guide (fast, looser).

A related observation: the Behavior Spec is **loaded as the AI's system prompt**. It is read by the AI, not just by humans. Conflating it with engineering-facing documentation muddies that purpose.

## Decision

**The DM Behavior Spec lives at `/behavior/default.md`, is versioned independently of the surrounding code, and is the single document loaded as the AI DM's primary system prompt context.**

The codebase describes platform **capabilities** ("the system supports secret rolls; the system supports a fudge tool"). The Behavior Spec describes **behavior** ("the AI uses secret rolls for these check types; the AI may invoke the fudge tool under these conditions"). Code does not specify behavior; the Behavior Spec does not specify capabilities.

The Behavior Spec is treated as a runtime asset — like a configuration file or a prompt template — rather than as documentation. It is versioned alongside the code that consumes it. In the long run, operators will be able to override the default at runtime (campaign-specific personalities, custom safety policies); the in-repo file is the default template, not the canonical behavior definition for any given installation.

## Consequences

**Positive**
- The codebase becomes stable. It changes when capabilities change, not when DM tone is being tuned.
- The Behavior Spec can iterate rapidly — including by non-engineers, including by experienced DMs who want to contribute prompt-engineering improvements without touching code.
- The Behavior Spec is a **system prompt artifact**, not just documentation. Its formatting and length are constrained by what the model needs to consume, not what a human reader needs.
- Operator-defined behavior overlays (campaign-specific spec edits, personality presets) compose cleanly on top of the base spec.

**Negative**
- Newcomers might not realize the Behavior Spec is the most important document for AI-DM quality. The README surfaces this.
- The spec has its own versioning rhythm separate from semantic versioning of the code. A spec change can ship without a code change.

**Neutral**
- The Behavior Spec follows a `vMAJOR.MINOR` versioning of its own, recorded in its version history appendix.
- Behavior Spec changes are landed via PR like any other change, but the review criteria are different: playtesting evidence and eval-fixture impact, not pure architectural review.
- A future ADR may formalize the Behavior Spec evaluation harness — replaying canonical scenarios against new spec versions to detect regressions.

## What this implies for the repo
- `/behavior/default.md` — the AI's system prompt (this default ships with the project).
- `/behavior/personalities/` (future) — distributable personality preset overlays.
- `/docs/adr/` — architectural decisions and rationale.
- `/eval/` — Behavior Spec evaluation fixtures and harness.
