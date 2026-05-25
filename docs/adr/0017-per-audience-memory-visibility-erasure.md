# ADR-0017: Per-audience memory visibility & erasure

## Status
Accepted (2026-05-20). **Refines [ADR-0014](./0014-episodic-memory-campaign-scoped-erasure.md)** — does not supersede it. ADR-0014's decision (shared episodic memory is campaign-scoped, jointly-authored, and not per-player erasable) stands unchanged; this ADR adds the *audience* dimension that 1:1 player↔DM side-channels introduce.

## Context

ADR-0014 settled that the campaign's episodic memory is shared content — a jointly-authored record of the group's story — and therefore **not** erasable per-player. That holds for everything said at the table.

[TDD 0026](../tdd/0026-player-dm-side-channels.md) introduces **1:1 private side-channels** between a single player and the DM. This creates a new kind of stored content that ADR-0014 didn't contemplate: **per-player private** conversation (and private-action deliberation) that is *not* shared with the table and *not* jointly-authored. We need to state, once, how visibility and erasure work across this new dimension without contradicting ADR-0014.

## Decision

All stored conversational content (dialogue rows, memory records) carries an **audience**: `table` | `player:<id>` | `gm`.

1. **`table` (shared) content is campaign-scoped** — jointly-authored, retained, and **not per-player erasable**. This is exactly ADR-0014, unchanged.
2. **`player:<id>` (private side-channel) content is personal data** — player-scoped and **individually erasable**: a player-scope erasure removes their private side-channel content (the player-erasure adapter's scope extends to it), while leaving shared `table` memory intact.
3. **`gm` content is operator-facing only** — hidden world state, secret DCs, NPC true motives. Never surfaced to any player's context; visible to the operator (sovereignty / audit) and erased with the campaign/tenant.
4. **Retrieval is audience-filtered.** A given conversation's hot context includes only its own audience + `table` + shared mechanical state — **never another player's `player:<id>` content, never `gm` content for a player**. This is the structural privacy guarantee that makes side-channels safe even against a cajoled or jailbroken model (it cannot reveal what is not in its context).

## Consequences

- The `audience` field becomes load-bearing across persistence, retrieval, and erasure routing (the schema + read paths must carry and honor it).
- Per-player erasure now has *more* to remove (their private side-channel content) — strictly an improvement to the data-subject story; shared-memory erasure semantics are unchanged from ADR-0014.
- Cross-player and GM-secret confidentiality is enforced **structurally** (context scoping), with behavior-spec rules + `eval:live` as the soft, secondary layer.
- "Private" means private *from other players*, not from the operator: side-channel content is still stored and auditable (operator sovereignty), as documented in PRIVACY.md.
- Disciplined `gm`-tagging of hidden world info is now a correctness requirement, not just hygiene — mistagging hidden info as `table`/player-visible would leak it.
