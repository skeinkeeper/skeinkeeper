# ADR-0015: Operator Configures Pre-Game; Skeinkeeper Performs All In-Play DM Actions

## Status
Accepted (2026-05-20).

## Context

Skeinkeeper's whole premise is that the AI *is* the Dungeon Master. The human who set it up (the "operator") brings the keys, the Foundry world, and the configuration — but once the group sits down to play, that person should be **just another player at the table**.

It is therefore a design defect if, during a session, the operator must perform any action a DM would normally perform — switching the active map as the party moves, applying damage, rolling for a hidden monster, advancing initiative, revealing fog. Each such action that falls to the operator breaks the premise and the experience.

This needs to be stated as an explicit invariant because it is the yardstick for deciding whether something is a bug, and because it drives a hard requirement on our VTT integration: the AI must be *able* to do, through tools, everything a DM does at the table.

## Decision

**Split responsibilities strictly by phase:**

- **Pre-game = the operator.** World preparation in Foundry (importing the adventure, importing/curating which scene represents each location, naming scenes, deleting duplicate maps), provider keys, DM-voice persona, eagerness default, consent expectations, campaign config. All of this happens before play.
- **In-play = Skeinkeeper.** Once a session starts, the AI performs **every** DM table action: activating/switching scenes, moving and revealing tokens, applying conditions and damage, rolling for NPCs/secret checks, advancing combat, revealing fog, voicing NPCs, adjudicating rules, pacing, and narrating. The operator takes **no** DM action.

**Corollaries:**
1. **Any in-play DM action that requires the operator is a bug**, tracked and closed — not an accepted limitation.
2. **The AI must have a tool for every in-play DM action.** Where the VTT (Foundry) supports an action but our MCP bridge does not expose it, that is a coverage gap to close (wire it, contribute it upstream, or fork the bridge). See the DM-action coverage audit ([TDD 0022](../tdd/0022-dm-action-coverage-audit.md)).
3. **The operator console is pre-game + observability**, not an in-play DM control panel. It configures and lets the operator *watch*; it is not where the game is run from.
4. **Out of scope for the AI:** things a VTT shouldn't decide either — what an NPC does next, the story, the rolls' *meaning*. Those are DM *judgment* (the AI's brain), not VTT *actions*. The invariant is about table **actions**, not authoring.

## Consequences

**Positive**
- A crisp, testable definition of "done" for the play experience: if the operator had to touch Foundry mid-session, we have work to do.
- Drives a concrete requirement set for the VTT bridge (the audit), and a principled basis for contributing-to / forking the bridge.
- Keeps the operator UI honest — pre-game + watch, never a DM cockpit.

**Negative / accepted**
- Some in-play DM actions are blocked today by the bridge's tool surface (e.g., direct HP changes, GM-side dice rolls, combat-tracker control). Under this ADR those are **bugs to close**, which raises the priority of bridge contributions or a fork (TDD 0022).

**Neutral**
- Pre-game curation can be involved (importing/naming scenes), but it's one-time setup and squarely the operator's job; we document it rather than automate it.

## Revisit when
- A "no-VTT, text-only" mode is added (the invariant still holds; the action set just shrinks to chat/state, no Foundry).
