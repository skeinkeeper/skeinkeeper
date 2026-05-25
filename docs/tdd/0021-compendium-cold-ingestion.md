# TDD 0021: Compendium-Backed Cold Ingestion
Status: implemented
PRD refs: 5.1, 4.2
PRD-rev: 10391ba
ADR constraints: 0002, 0004, 0007, 0011, 0012
Author: maintainers
Date: 2026-05-19
Related TDDs: [0014 (McpFoundryClient)](./0014-mcp-foundry-client.md), [0019 (cold/episodic memory)](./0019-cold-episodic-memory.md)

## Approach

Per ADR-0012 and hard rule #9, Skeinkeeper does **not** encode game-system rules
itself — Foundry's per-system module is the ruleset, and the LLM supplies
general rules knowledge. The remaining question (raised in review) is how the DM
gets *specific* system content — a monster's stat block, a spell's effect, an
item's rules — for the system the connected world actually runs.

Design doc 0019 added the cold tier and named two sources: promoted episodic
summaries and operator-imported lore. This doc adds a third: **content read
from the connected Foundry world's compendia**, so "the rules/monsters/items"
come from whatever system is installed (dnd5e, pf2e, …) with no per-system
Skeinkeeper code. This is the concrete realization of 0019 §6's "cold ingestion"
against Foundry.

The OSS bridge exposes `list-compendium-packs`, `search-compendium`
(`{query, packType?}`), and `get-compendium-item` (`{packId, itemId}`). There is
**no "enumerate a whole pack" tool**, so ingestion is **search-driven**, not a
bulk dump — which also matches ADR-0002's "never place cold content en masse."

### 1. Compendium reads (vtt-foundry)

A `readCompendiumEntries(caller, { queries, packType?, limitPerQuery? })` helper
in the Foundry plugin runs `search-compendium` for each query, parses the
bridge's result shape, de-dupes by id, and returns typed `CompendiumEntry[]`:

```ts
interface CompendiumEntry {
  id: string; name: string; type: string;
  packId: string; packLabel?: string; system?: string;
  text: string; // name + type + description + summary, for embedding
}
```

Bridge result parsed: `{ results: [{ id, name, type, pack: {id,label},
description, summary }], gameSystem }`. Parsing is unit-tested with
`FakeMcpToolCaller`; the live search is operator-validated.

### 2. Generic cold ingestion (orchestrator/memory)

`ingestColdEntries(embed, store, { campaignId, entries })` embeds each entry's
text (batched) and upserts a `cold` `MemoryRecord` (deterministic id so
re-ingest updates rather than duplicates; structured fields preserved in
`metadata.deltas`). Generic — reused for compendium content *and* operator lore
(0019 §6). Unit-tested with `FakeEmbeddingProvider` + `InMemoryMemoryStore`.

### 3. Wiring (app)

A `pnpm ingest:compendium <terms…>` script: builds the real `StdioMcpToolCaller`
from `FOUNDRY_MCP_COMMAND`, reads compendium entries for the given terms,
ingests them into the campaign's `LanceMemoryStore` with the local embedder.
Operator-run, occasional (content changes rarely). Retrieval is already wired
(0019 §5), so ingested content surfaces in hot context when relevant.

### 4. Why search-driven, not bulk

No enumerate tool exists, and ADR-0002 forbids dumping cold content wholesale.
Operators ingest the terms relevant to their campaign ("goblin", "fireball",
"grapple", monster/spell names from the adventure). A future **live
`compendium_lookup` tool** (the AI searches mid-adjudication) is the
complementary path; it needs Foundry access in the tool-dispatch context, so
it's deferred to its own change.

## Components & interfaces

Covered under Approach.

## Data & state

Covered under Approach.

## Sequencing / implementation plan

Covered under Approach.

## Failure modes & edge cases

Covered under Approach.

## Requirement traceability

| PRD ref | Requirement | Satisfied by |
|---------|-------------|--------------|
| 5.1 | System content (monsters, spells, items) available to the DM without per-system Skeinkeeper code | `readCompendiumEntries` reads from whatever Foundry system is installed; no per-system logic in Skeinkeeper |
| 4.2 | Cold memory tier populated with campaign-relevant content | `ingestColdEntries` upserts compendium entries as `cold` MemoryRecords into the LanceDB campaign store; retrieval surfaces them in hot context |

## Dependencies considered

None — no new third-party dependency introduced by this design.

## PRD conflicts surfaced (and resolution)

None — this design directly implements the cold ingestion path established by ADR-0002 (four-tier memory) and ADR-0012 (Foundry-as-source-of-truth); no PRD requirement proved infeasible or contradictory.

## Decisions to promote (ADR candidates)

None — the durable decisions (no per-system Skeinkeeper rules code, cold ingestion via Foundry compendia, search-driven not bulk) are subsumed by ADR-0002, ADR-0011, and ADR-0012.

## Alternatives considered

- **Bulk pre-ingest of entire packs.** No bridge tool enumerates a pack, and it
  violates ADR-0002's en-masse rule. Rejected.
- **A `ruleset-dnd5e` plugin encoding rules.** Rejected by ADR-0012 / hard rule
  #9 — duplicates Foundry + the model.
- **Live-only `compendium_lookup` tool, no cold store.** Good and complementary,
  but requires extending the tool-dispatch context with Foundry access; deferred.
  Cold ingestion gives offline-fast retrieval now.

## Privacy implications

Compendium content is game-system content, not personal data. Commercial module
content remains operator-supplied (ADR-0007); we read whatever the operator's
licensed world contains. Embeddings stay on-box with the local embedder default
(0019). Erasure is campaign/tenant-scoped via the existing memory adapter.

## Eval implications

`readCompendiumEntries` (parse) and `ingestColdEntries` (embed+store) are pure
and unit-tested with fakes. The live bridge search + retrieval-quality of
ingested content are operator-validated.

## Open questions

- **Seed-term ergonomics** — terms via CLI vs. deriving them from the adventure;
  maybe auto-ingest scene/monster names the DM encounters.
- **`get-compendium-item` for fuller detail** — search returns summaries; pulling
  full item detail for ingested hits is a follow-up if summaries prove thin.
- **The live `compendium_lookup` tool** (§4) as the complementary path.
