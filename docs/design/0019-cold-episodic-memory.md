# Design Doc 0019: Cold & Episodic Memory (Phase 4)

> Status: Accepted
> Author: maintainers
> Date: 2026-05-19
> Related ADRs: [ADR-0002 (four-tier memory model)](../adr/0002-four-tier-memory-model.md), [ADR-0004 (plugin interface pattern)](../adr/0004-plugin-interface-pattern.md), [ADR-0008 (tenant scoping)](../adr/0008-tenant-scoping.md), [ADR-0010 (privacy as architecture)](../adr/0010-privacy-as-architecture.md)
> Related design docs: [0008 (LLM provider interface)](./0008-llm-provider-interface.md), [0011 (orchestrator turn loop)](./0011-orchestrator-turn-loop.md), [0013 (dialogue persistence + session lifecycle)](./0013-dialogue-persistence-session-lifecycle.md)

## Context

ADR-0002 defines a four-tier memory model. Hot (in-prompt) and warm (Foundry +
TenantDb) are built. This doc designs the two unbuilt tiers:

- **Cold** — durable, relevance-retrieved knowledge: campaign/lore content, SRD
  rules, NPC/location facts. Chunked + embedded in a vector store, retrieved per
  turn so it never sits in the prompt en masse.
- **Episodic** — per-session structured summaries generated post-session,
  embedded for retrieval, periodically consolidated into "arc summaries" when
  they exceed a token budget (ADR-0002).

ADR-0002 commits to **LanceDB** as the v1 vector store and leaves the *embedder*
unspecified. The embedder is the open decision; everything else implements
ADR-0002.

## Decision

### 1. `EmbeddingProvider` interface (plugin, ADR-0004) — local default

```ts
export interface EmbeddingProvider {
  readonly name: string;
  readonly dimensions: number;
  embed(texts: ReadonlyArray<string>): Promise<number[][]>;
}
```

- **Default: a local, in-process model** (`@skeinkeeper/embed-local`) — no extra
  API key, no per-call cost, content never leaves the operator's machine. Fits
  the self-hosted ethos and ADR-0010 (privacy). Candidate: **fastembed-js**
  (ONNX `bge-small-en-v1.5`, 384-dim, MIT, small + fast) — see alternatives.
- **Optional hosted** (`@skeinkeeper/embed-voyage`, `@skeinkeeper/embed-openai`)
  — better retrieval quality at the cost of a key + content leaving the box.
  Operator opt-in; flagged in the privacy doc.
- A `FakeEmbeddingProvider` (deterministic vectors) for unit tests, mirroring
  `FakeLLMProvider`.

The embedding model identity + dimensions are recorded with each stored vector
so a model change is detectable (vectors from different models aren't
comparable; a model switch requires a re-embed, see open questions).

### 2. `MemoryStore` interface + LanceDB impl

A thin, tenant-scoped store interface so the orchestrator's retrieval logic is
testable without LanceDB (the FoundryClient/MockFoundryClient pattern):

```ts
export interface MemoryRecord {
  id: string;
  kind: "cold" | "episodic" | "arc";
  text: string;
  vector: number[];
  metadata: {
    campaignId: string;
    sessionId?: string;
    createdAt: number;
    embedModel: string;
    // structured deltas preserved separately from prose (ADR-0002)
    deltas?: Record<string, unknown>;
  };
}
export interface MemoryStore {
  upsert(records: ReadonlyArray<MemoryRecord>): Promise<void>;
  query(vector: number[], opts: { campaignId: string; kinds?: string[]; topK: number }): Promise<MemoryRecord[]>;
  deleteByCampaign(campaignId: string): Promise<number>;
  deleteByTenant(): Promise<number>;
}
```

- **LanceDB impl** (`@lancedb/lancedb`), **one DB directory per tenant**
  (`<dataDir>/memory/<tenantId>/`) so tenant isolation and tenant-scoped
  erasure are filesystem-level (delete the directory), consistent with ADR-0008.
- **In-memory fake** for tests (cosine top-k over an array).

### 3. Episodic summary generation (post-session)

`endSession` (doc 0013) gains an optional, async memory step:

1. Read the session's dialogue (the persisted transcript).
2. An LLM call (orchestration tier — Haiku/Sonnet, cheap) produces a
   **structured summary**: prose recap **plus** explicit structured deltas
   (quest flags changed, NPCs met/died, party decisions, unresolved threads).
   The deltas are stored separately from the prose so consolidation can't lose
   them (ADR-0002).
3. Embed the summary; `upsert` an `episodic` record.

This is best-effort and must not block session teardown; failures are logged,
not fatal.

### 4. Consolidation (arc summaries)

When a campaign's episodic records exceed a configured token budget, a
consolidation pass merges the oldest summaries into a higher-level `arc`
record — compressing prose while **preserving the union of structured deltas**.
Runs post-session (or on demand), not in the turn hot path.

### 5. Retrieval into hot context

`assembleHotContext` (doc 0011) gains a retrieval step before building the LLM
request:

1. Build a query string from the recent dialogue window (and/or the triggering
   utterance).
2. `embed` it; `query` the MemoryStore for top-k `cold` + `episodic`/`arc`
   records for the campaign.
3. Inject a token-bounded **"Relevant memory"** section into hot context. Cold
   content is *never* dumped en masse — only retrieved chunks (ADR-0002).

Retrieval is bounded (small top-k, token cap) and runs per responding turn (not
per decider call — the cheap Haiku decider stays lean).

### 6. Cold content ingestion

Cold records come from: episodic summaries (promoted), and **operator-imported
lore/notes** (a CLI/Web action that chunks + embeds a text/markdown file into
the campaign's cold tier). Commercial module text stays operator-supplied
(ADR-0007); Skeinkeeper ships no campaign content.

### 7. Erasure & privacy

- **Tenant / campaign erasure**: a `MemoryAdapter` (DeletionAdapter) deletes the
  tenant's LanceDB directory / the campaign's records — the documented deletion
  path required by hard rule #8.
- **Episodic erasure is permanently campaign/tenant-scoped, never player-scoped**
  (settled decision). A campaign's episodic memory is the *shared* record of what
  happened at the table — jointly authored by everyone present, not any one
  player's personal data. A single player withdrawing cannot make the whole group
  forget what was collectively said and done; that isn't how a shared story (or
  the real world) works. So per-player erasure removes that player's **raw
  dialogue lines** (the `dialogue` table, already handled) and their identity
  mapping, but the campaign's episodic summaries persist and are erased only on
  **campaign or tenant deletion**. This is deliberate and not revisited.
  `docs/PRIVACY.md` and the **consent text** must disclose it clearly, so players
  understand *at consent time* that the campaign's shared memory is not
  individually erasable. (This is a privacy-posture decision; capture it as an
  ADR alongside the implementation.)
- **Local embeddings keep content on-box** (the default) — the privacy-preferred
  path. Hosted embedding sends content to a third party; opt-in + disclosed.
- `docs/PRIVACY.md` "what Skeinkeeper stores" already lists episodic memory as
  Phase 4; this doc's implementation updates it (storage list + erasure cascade
  + the hosted-embedding disclosure) per hard rule #15.

## Alternatives considered

- **Embedder: fastembed-js (local default)** vs **transformers.js** (heavier,
  broader model support) vs **hosted Voyage/OpenAI** (best quality, key + cost +
  data egress). Chose local-default-with-hosted-optional per the self-hosted
  ethos and operator agreement; fastembed for its small ONNX footprint.
- **Vector store: LanceDB** (ADR-0002's v1 choice) vs **sqlite-vec** (would
  unify storage in the existing SQLite DB, simpler ops + reuse of tenant-scoping
  and SQL erasure) vs **pgvector** (needs Postgres, not our stack). ADR-0002
  accepts LanceDB for v1 and frames it as "a choice, not a constraint"; we
  follow it. *sqlite-vec is noted as a credible future simplification* — if
  running two stores proves operationally heavy in alpha, it's the first thing
  to revisit (would be a superseding ADR).
- **No cold tier, bigger context window** — rejected by ADR-0002 (cost, and the
  model is distracted by irrelevant content); retrieval is the point.

## Telemetry implications

Candidate `memory.retrieved { kind, topk_bucket, latency_bucket }` and
`memory.summarized { delta_count_bucket }`, deferred. Counts/buckets only, no
content, per ADR-0009.

## Eval implications

- **Retrieval** is unit-testable: a `FakeEmbeddingProvider` (deterministic
  vectors) + the in-memory `MemoryStore` → assert top-k ordering and the
  hot-context injection.
- **Summary generation** is testable with `FakeLLMProvider` scripting a summary
  + deltas; assert the `episodic` record shape and that deltas are preserved.
- **Behavior fixture**: given a stored memory ("in session 2 the party spared
  the goblin Yeemik"), the DM recalls it when relevant in a later turn.

## Open questions

- **Re-embedding on model switch** — vectors from different embed models aren't
  comparable; switching providers needs a re-embed migration. Detected via the
  stored `embedModel`; the migration is out of scope for the first cut.
- **Local embedding cost** — model load time + per-embed CPU at a live table;
  whether to embed asynchronously / batch.
- **Retrieval query construction** — last utterance vs. dialogue window vs. a
  distilled query; tuned with eval fixtures.
- **Consolidation trigger + cadence** — token budget value and whether
  consolidation is automatic or operator-triggered for alpha.
