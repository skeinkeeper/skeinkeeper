# ADR-0014: Episodic Memory Is Campaign-Scoped Shared Content

## Status
Accepted (2026-05-19).

## Context

Phase 4 adds the episodic memory tier (ADR-0002, [design doc 0019](../design/0019-cold-episodic-memory.md)): per-session structured summaries, embedded for retrieval, so the AI DM can reference Session 2 in Session 9.

ADR-0010 (privacy as architecture) requires every persistent store to have a documented deletion path, and per-player erasure across the data model. That raises a question for episodic summaries: when a player invokes erasure, must the campaign's session summaries that *mention* them also be deleted or regenerated?

Episodic summaries are session-level, jointly-authored records ("the party spared Yeemik"; "Aragorn opened the vault"). They are not keyed to a single player and generally describe the whole table's collective play.

## Decision

**Episodic memory is the shared, campaign-scoped record of the table, and its erasure is permanently scoped to campaign or tenant — never to an individual player.**

- Per-player erasure removes that player's **raw dialogue lines** (the `dialogue` table) and their **identity mapping** (`player_character_map`), as today.
- The campaign's **episodic summaries persist** through a per-player erasure and are deleted only when the **campaign or tenant** is deleted (FK/namespace cascade via the memory store's `deleteByCampaign` / `deleteByTenant`).

A campaign is a shared story authored by everyone at the table. One player withdrawing cannot compel the rest of the group to forget what was collectively said and done — that is not how a shared narrative (or the real world) works. The summaries are joint content, not one participant's personal data, so the legitimate basis for retaining them is the shared record itself.

This is a deliberate, permanent scope decision, not a deferral.

## Consequences

**Positive**
- Clear, documented deletion path satisfying ADR-0010: campaign/tenant deletion erases episodic memory; the memory store needs no per-subject tagging or summary-regeneration machinery.
- The shared campaign record stays coherent — erasing one player can't silently corrupt the group's continuity.
- Simpler implementation: no per-record subject tags, no post-erasure re-summarization.

**Negative / accepted trade-off**
- A player's actions may remain referenced in episodic summaries after their personal erasure. This is an intentional limitation, defensible because the summaries are shared content rather than personal data.
- It must be **disclosed up front**: `docs/PRIVACY.md` and the **voice-consent text** state that the campaign's shared memory is not individually erasable, so players understand this at consent time rather than discovering it after an erasure request.

**Neutral**
- Cold-tier content (operator-imported lore, SRD) is likewise campaign/tenant-scoped.
- Raw transcripts and identity mappings remain fully per-player erasable; this ADR narrows only the episodic *summaries*.

## Revisit when
- A jurisdiction the operator runs in is determined to require individual erasure of shared-record derivatives (operators are the data controllers per ADR-0010; this would be their compliance call, and could motivate an optional per-subject-tag mode).
