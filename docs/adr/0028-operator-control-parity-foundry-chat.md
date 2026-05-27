# ADR-0028: Operator control parity — console + Foundry chat commands

Status: accepted (supersedes [ADR-0016](./0016-operator-control-parity-across-surfaces.md))
Date: 2026-05-27
Scope: operator-controls

## Context

[ADR-0016](./0016-operator-control-parity-across-surfaces.md) established
the operator-control parity invariant: every operator action/setting is
available on **two surfaces**, the change is reflected live on both, and
both surfaces converge on a single `SessionManager` write path so they
cannot drift. ADR-0016's _Decision_ named the two surfaces as the **web
console** and **Discord slash commands**.

[ADR-0025](./0025-foundry-as-table-text-and-operator-surface.md) — the
surface-model ADR from the PRD-rev `9f8518a` → `59a0fda` design pass —
re-homes the operator's primary chat surface from Discord to Foundry
GM chat. Operator commands are received as Foundry chat events
(`/skeinkeeper <verb> <args>`), parsed by the bridge driver, and
authorized by Foundry GM role. ADR-0025's _Corollaries_ include
"Operator command parity is on Foundry chat, not Discord slash" — but
that's a Consequences-level statement riding on top of ADR-0025's
surface-mapping decision, not a decision-level update to ADR-0016
itself.

After ADR-0025 lands, ADR-0016's Decision text still says "console and
Discord slash commands" as the parity pair. A future TDD author reading
only ADR-0016 (which is binding under "Only `accepted` ADRs are binding
constraints for new TDDs") would see Discord slash commands as the
required second surface and could legitimately introduce them. That
contradicts ADR-0025's Foundry-only operator surface and the work in
TDD 0040 (which supersedes TDD 0025's parity TDD with Foundry chat
commands as the second surface).

Per the project's append-only ADR discipline, substantive changes to an
accepted ADR require a superseding ADR, not an in-place rewrite. This
ADR is that supersession.

## Decision

**Operator control parity holds across two surfaces: the web console
and Foundry chat commands.** Both surfaces:

- Expose every operator action/setting in the parity table maintained by
  [TDD 0040](../tdd/0040-operator-control-parity-foundry-chat-commands.md)
  (which supersedes TDD 0025).
- Call into the single `SessionManager` write path; no surface duplicates
  the control logic.
- Reflect each other's changes live via the existing in-process
  `AppEvent` bus (SSE to the console; the same bus drives the Foundry-
  chat-command inline ack response from TDD 0040).
- Send the per-control authorization check at the entry point of each
  surface (console: existing auth; Foundry chat: GM-role check via
  `FoundryClient.listUsers()`, per TDD 0040 §3).

**The parity invariant carries forward unchanged:** a new operator
control lands on **both** surfaces in the same change, or not at all.
Player-facing self-actions (e.g., `/skeinkeeper consent`) remain
exempt — those are player controls, not operator controls.

**Corollaries**

- **Cold-start asymmetry persists.** "Start session" is a web-console-
  only control until the standing-gateway-client work lands (operator
  cannot start a session via Foundry chat command before the bridge is
  connected to a running session — same constraint as the Discord-side
  cold-start gap in ADR-0016). The exception applies to _start_, not to
  any other control.
- **CLAUDE.md anti-pattern entry updates with this ADR.** The "Adding an
  operator control to only one surface" anti-pattern in
  [`skeinkeeper/CLAUDE.md`](../../CLAUDE.md) referenced ADR-0016 and
  TDD 0025; the same ship-PR for this ADR updates it to reference this
  ADR and TDD 0040.
- **The single `SessionManager` write path is unchanged.** This ADR
  changes only which carriers reach `SessionManager.X`; not the method
  signatures, not the AppEvent bus, not the event types.

## Consequences

**Positive**

- ADR-0016's binding text now matches the as-built surface mapping
  under ADR-0025. A future TDD author who reads only this ADR (or
  reads ADR-0016 and follows the supersession link) reaches the
  correct conclusion about the second surface.
- The parity invariant's _spirit_ — every control on two surfaces, one
  write path, live cross-surface sync — is preserved. The supersession
  is a carrier swap, not a model change.
- Authorization moves to the appropriate boundary: Foundry GM role is
  the natural privilege check for operator commands on a Foundry surface,
  matching how human operators run their own Foundry instance.

**Negative / accepted**

- **Foundry chat as the second surface concentrates a dependency.**
  Under ADR-0016, the operator could still issue Discord slash commands
  when Foundry was unreachable (Discord and Foundry are independent
  carriers). Under this ADR, Foundry-down means operator commands route
  only through the web console — see [TDD 0039](../tdd/0039-foundry-down-session-lifecycle.md)
  for the explicit pause-and-resume failure mode. The web-console
  parity (this ADR's first surface) is what preserves operator agency
  during a Foundry outage; that parity becomes load-bearing rather than
  convenient.
- **Discord slash commands are out of scope for v0.5 operator controls.**
  This is intentional, not a regression: the surface-model decision
  (ADR-0025) consolidates the operator's attention on Foundry + web
  console, removing the alt-tab cost of Discord-side controls. Operators
  who preferred Discord slash commands lose that affordance.

**Neutral**

- The verb taxonomy (`/skeinkeeper <verb> <args>`) is preserved verbatim
  from the Discord slash-command era. TDD 0040 §"Verb taxonomy
  continuity" carries every prior verb forward; only the carrier
  changes. Operators who memorized the slash-command verbs do not have
  to relearn them.

## Revisit when

- An additional operator surface emerges (a mobile companion app; a
  remote co-DM display) and the parity invariant needs to extend to a
  third carrier. The pattern should extend additively — every new
  surface joins the parity table; the single `SessionManager` write
  path absorbs the new entry point.
- Foundry chat itself becomes operationally unsuitable for any reason
  (e.g., a Foundry rework that breaks chat-event delivery) and a
  different second surface needs to replace it.
- The cold-start asymmetry is closed (standing gateway client lands)
  and operators can start sessions from either surface. That removes
  the corollary above but does not change the binding decision.
