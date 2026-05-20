# ADR-0016: Operator controls have parity across the console and Discord, via one write path

## Status
Accepted

## Context
The operator drives Skeinkeeper from two surfaces: the local web console and Discord slash commands (the same Discord surface players already use for voice consent). As we add operator controls (eagerness, DM voice, operator designation, session stop, …), there's pressure for each control to grow up on one surface only, and for the two surfaces to drift out of sync — a control changed in Discord leaving the console showing stale state until a manual refresh. That's a confusing, error-prone operator experience, and duplicated control logic across the console API handlers and the slash-command handlers would inevitably diverge.

The design of this parity (the control table, the event model, the deferred `session start` gateway constraint) is in [design doc 0025](../design/0025-operator-control-parity.md); this ADR records the *architectural decision* that doc implements.

## Decision
**Every operator action/setting is available on both the web console and Discord slash commands, and any change is reflected live on the other surface.** This is enforced architecturally:

1. **One write path per control.** Each control is a single method on `SessionManager`; both the console API handlers and the slash-command handlers call that method (which validates, mutates, persists, and emits). No surface reimplements control logic.
2. **Live cross-surface sync via the event bus.** Each control method emits a typed `AppEvent`; the console streams these over SSE and applies them in place. `GET /api/state` returns the same fields for initial paint.

Per-player actions (e.g., `/skeinkeeper consent`) are **not** operator controls and are exempt — a player consenting to their own voice processing is not an operator setting.

## Consequences
- A new operator control lands on **both** surfaces in the same change, or not at all (also captured as an anti-pattern in `CLAUDE.md`).
- The console and Discord can't show contradictory state; there's a single source of truth (`SessionManager`) and a single notification channel (the `AppEvent` bus).
- Some controls have a surface-specific constraint that this ADR explicitly tolerates rather than forces: `session start` from Discord requires the bot to already be online, which today only happens once a session is running — so cold-start stays console-only until/unless a standing gateway client is adopted (open item in design doc 0025 §4).
- New cross-surface coupling rides untyped JSON between TypeScript and the browser client; the shared payload shapes must be kept consistent by hand (a known soft spot).
