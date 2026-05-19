# ADR-0010: Privacy as Architecture, Not Operational Commitment

## Status
Proposed (2026-05-18)

## Context

Skeinkeeper is open-source software that an operator runs on their own infrastructure. The operator processes data about themselves and their friend group. In the GDPR sense, the operator is the data controller; Skeinkeeper is software they choose to run.

This distinction matters for what privacy commitments make sense to make:

- **Architectural commitments** apply: encryption at rest, typed PII fields, deletion paths, audit logs, voice ephemerality. These are properties of the code, and they help every operator. They're cheap to build, hard to retrofit, and clearly the right call.
- **Operational commitments** don't apply: external DPO retainers, signed DPAs with sub-processors, breach notification timelines on behalf of operators, SOC 2 audits. These are obligations of running a hosted service for paying customers. They don't fit a software project distributed for self-hosted use.

Conflating the two leads to either over-promising (committing to things software can't deliver) or under-investing in privacy basics (treating it as not-our-problem). The right answer is to be explicit about which is which.

## Decision

**Skeinkeeper's privacy commitments are architectural, not operational.** The project commits to building software that gives operators a strong foundation for being good controllers of their own data. The project does not commit to taking on controller-side operational obligations on behalf of operators.

### Architectural commitments (always-on, every release)

1. **All secrets encrypted at rest** using OS keyring (libsecret on Linux, Keychain on macOS, Credential Manager on Windows) or libsodium-sealed config fallback.

2. **TLS 1.3 on all network-facing surfaces** (Foundry connection, LLM API calls, voice provider connections).

3. **PII type marker `PII<T>`** in code. Personal-data fields are statically distinguishable. Downstream code that handles them must do so explicitly. Encrypted at rest by default.

4. **Every persistent data store has a documented deletion path.** Per-player erasure cascades across all storage including the vector store. Per-campaign erasure works the same way. CI gate: any PR adding a new persistent store must register a deletion adapter.

5. **Tenant scoping in the data model** per [ADR-0008](./0008-tenant-scoping.md). Prevents accidental cross-data leakage between campaign groups.

6. **Audit log of every state mutation, tool call, and AI decision.** The operator can answer "what happened in our session" and "why did the AI do that" without relying on us.

7. **Voice data is strictly ephemeral.** Audio bytes streamed to STT, transcribed, discarded immediately. Never persisted anywhere. Diarization is by Discord user ID, not voice analysis.

8. **Consent records** for voice processing in a local `consents` table. Players consent via a one-time Discord DM flow on first voice-channel join. Withdrawal via slash command.

9. **No telemetry by default** ([ADR-0009](./0009-telemetry-opt-in.md)). Operator opts in with informed consent if they want to help improve the project.

10. **Self-service data export and deletion** via CLI for the operator. `skeinkeeper player:delete <discord-id>`, `skeinkeeper campaign:export <name>`, etc.

### What the project does NOT commit to

These are operational obligations of a hosted service, not properties of OSS software:

- **No external DPO retained by the project.** The operator is their own controller; they retain their own counsel if their use case warrants.
- **No signed DPAs with sub-processors.** Each operator's relationship with Anthropic, ElevenLabs, etc. is governed by those providers' own terms, which the operator accepted when signing up.
- **No platform-curated sub-processor list.** The operator chooses their own providers via the web UI; there's no platform-managed list because there's no platform.
- **No breach notification timelines from the project.** If a vulnerability is found in Skeinkeeper, we publish a security advisory through standard OSS channels. The operator decides whether and how to notify their players, per their own obligations.
- **No SOC 2, ISO 27001, or formal certifications.** These attest properties of hosted services, not of software.
- **No DPIA conducted by the project.** The DPIA assesses risk of a specific deployment; operators run their own assessments if their jurisdictions require.
- **No GDPR Article 28 controller-processor framework with operators.** Skeinkeeper isn't a processor under GDPR; it's software the operator runs themselves.

### What this means for documentation

The README and CONTRIBUTING.md surface this stance clearly:

> Skeinkeeper is software you run yourself. The project provides strong architectural foundations for privacy — encryption, deletion paths, audit logs, no phone-home by default — but you (the operator) are the data controller for whatever data your deployment processes. Skeinkeeper does not assume controller responsibilities on your behalf.

A separate `/docs/PRIVACY.md` document explains:
- What data Skeinkeeper stores locally (campaign state, transcripts, audit logs, consent records).
- What data Skeinkeeper sends to external providers (LLM/TTS/STT calls — only to providers the operator has configured).
- How operators can delete data, export data, and audit access.
- How to talk to their players about voice consent and data handling.
- A note that operators who serve players in GDPR-covered jurisdictions may have their own controller obligations that Skeinkeeper helps support but does not fulfill.

## Consequences

**Positive**
- Honest framing: we say what we commit to, we don't commit to things software can't deliver. Self-hosted users trust this.
- The architectural commitments are real and visible in code: deletion paths exist, encryption is enforced, audit logs are written. Operators can verify rather than trust.
- No operational compliance overhead. No DPO retainer, no DPA negotiations, no certification audits.

**Negative**
- Some prospective operators may want a more turnkey privacy story than "you're the controller; we give you the tools." We accept that.
- Operators in highly regulated industries (healthcare, education with minors, finance) may need more than Skeinkeeper provides at this layer. That's appropriate; specialized deployments need specialized counsel.

**Neutral**
- The age gate (16+ for accounts, 18+ for voice) becomes an operator decision rather than a project constraint. Documented as a strong recommendation; not enforced because we can't enforce it.
- The EU AI Act's transparency requirement (Art. 50 — users informed they're interacting with AI) is met by the in-Discord consent flow regardless of operator jurisdiction. We do this because it's right.

## Hard rules implied by this ADR

These become CI checks, code-review gates, or definition-of-done items:

1. **Every persistent data store has a documented deletion adapter.** Test verifies erasure.
2. **PII type marker is used consistently.** Lint rule flags unmarked candidate fields (heuristic; not perfect).
3. **Audit log entry for every tool call and state mutation.** Architectural; enforced by the tool dispatcher.
4. **Voice audio is never persisted.** Test verifies the pipeline discards bytes after STT.
5. **Consent table is consulted before any voice processing.** Test verifies refusal when consent is missing.
6. **Encryption-at-rest applies to PII-marked fields.** Verified at the storage layer.

## What this ADR does NOT decide

- The specific UX of the consent flow. That's a design doc.
- Whether to ship any default Lines & Veils as a starting point.
- The full contents of `/docs/PRIVACY.md`. That's a separate doc.

## Revisit when
- A clear operator use case emerges that requires architectural changes the project should make on operators' behalf.
- The privacy regulatory landscape introduces obligations on software publishers.
