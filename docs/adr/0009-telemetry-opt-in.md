# ADR-0009: Telemetry Off By Default, Opt-In Only

## Status
Proposed (2026-05-18)

## Context

Skeinkeeper is open-source, self-hosted software that processes personal data (player voice, character names, campaign content). The audience self-selects for privacy sensitivity: people who choose self-hosted software are people who care about where their data goes.

Telemetry-by-default in an OSS self-hosted project is a community-trust killer. Multiple well-known projects (Audacity, Homebrew, several VS Code extensions) have faced community revolts when uninvited telemetry was discovered. The norm in privacy-respecting OSS is **off by default, prominently disclosed, easy to enable, easy to disable**.

At the same time, a typed telemetry library is genuinely useful:
- A meaningful subset of operators *will* opt in to anonymous analytics if it's easy and the disclosure is honest, and that data helps improve the project.
- A two-stream architecture (anonymous product analytics + crash/error reporting) is a sound design pattern regardless of when emissions fire.
- The discipline of "every user-visible feature has a named telemetry event" yields better-organized code and clearer feature boundaries even if events never ship.

## Decision

**Telemetry is off by default. The plumbing exists. Operators opt in with explicit, informed consent.**

Specifically:

1. **Out-of-the-box state: zero phone-home.** A fresh `docker compose up` of Skeinkeeper sends nothing to any external service except the LLM/TTS/STT providers the operator has explicitly configured. No analytics, no crash reports, no usage pings.

2. **Two architecturally separate streams:**
   - **Anonymous product analytics** — opaque rotating tokens, no PII, type-level rejection of identifying fields. Routes to a maintainers-operated PostHog project when enabled.
   - **Crash and error reporting** — anonymized stack traces and error context. Routes to a maintainers-operated Sentry project when enabled.

3. **Both streams default to disabled.** Enabling requires an affirmative click in the local web UI's Settings → Telemetry page, with a plain-English disclosure of:
   - What data is collected
   - Where it's sent
   - How long it's retained
   - How to disable it
   - Why the maintainers want it (improving the project)

4. **The telemetry library refuses to send anything if not enabled.** No "default-on for some users," no A/B rollout. Off means off.

5. **The typed event registry** lives in `/telemetry/events.ts` — typed, versioned, documented. Events are defined whether or not they fire.

6. **A "Local mode only" badge** is visible in the web UI when telemetry is off. Reassures the operator that nothing is leaving their machine beyond their explicitly configured providers.

7. **Local logging is always on.** Skeinkeeper writes structured logs to a local file. The operator can read them at any time. This supports debugging and the cost dashboard, both of which are useful regardless of telemetry choice.

## Consequences

**Positive**
- Trust: the privacy-sensitive user base finds Skeinkeeper safe to run.
- Differentiation: many commercial alternatives are silent or vague about telemetry. "Zero phone-home by default" is a real signal.
- The opt-in subset that does enable analytics provides high-quality data — they're engaged users who chose to help.
- The typed-event discipline applies equally whether events fire or not. Code stays well-organized.

**Negative**
- Smaller and more selection-biased dataset than always-on telemetry. Decisions about general behavior must rely on community feedback (GitHub issues, Discord conversations) more than aggregate metrics.
- Some product questions ("how often does feature X actually get used?") may be unanswerable for non-opted-in users. We live with that.

**Neutral**
- The opt-in UX matters. A grudging, buried toggle yields near-zero participation. A clear, honest, prominently-placed prompt during first-run setup gets meaningfully better participation. Worth designing well.
- We don't try to coerce participation. No "you'll get better features if you enable" tricks.

## What about the Foundry module?

The Foundry module is operator-installed in the operator's Foundry instance. It must not phone home under any circumstance — not even with opt-in — because the Foundry community has strong norms about modules being trustworthy. The Foundry module is a local-only client that talks to the operator's local Skeinkeeper service; that's it.

## Hard rules implied by this ADR

These become CI checks, lint rules, or code-review gates:

1. **The telemetry library refuses to send anything if not opted in.** Test verifies this.
2. **All telemetry emissions go through the typed wrapper, not direct SDK calls.** Enforced by lint rule.
3. **First-run setup includes an explicit, unambiguous telemetry prompt.** UI test verifies this.
4. **No PII in product analytics events** even when opted in. Type-level rejection.
5. **No campaign or message content in any event** even when opted in. Type-level rejection.

## What this ADR does NOT decide

- The specific event taxonomy. That's in `/telemetry/events.ts` and its companion documentation.
- The PostHog / Sentry project setup for maintainers. Operational detail.

## Revisit when
- A clear community signal emerges that the opt-in rate is too low to support project decisions and a different approach is needed.
- The privacy regulatory landscape shifts in ways that affect self-hosted telemetry.
