# ADR-0008: Tenant Scoping in the Data Model

## Status
Accepted (2026-05-18)

## Context

Skeinkeeper persists campaign state, character data, episodic memories, audit logs, and other operator-controlled records. The natural unit of isolation for that data is the **campaign group** — the operator and their friends playing together. In the common case, an operator runs exactly one Skeinkeeper instance for exactly one group.

But the boundary still matters even in single-operator deployments:

1. An operator may run **multiple campaign groups** in the same instance (one for their D&D group, one for their Pathfinder group). State from one group must never leak into the other.
2. An operator may **share a machine** with another household member, each running their own instance against the same underlying database server. Their data must stay isolated.
3. An operator may **back up and restore selectively** — exporting one group's data without exporting another's.
4. **Code reviewers benefit from seeing scope explicitly.** A query that reads `characters` is harder to reason about than one that reads `characters WHERE tenant_id = ?`. The scoping makes data-flow analysis tractable.

Without a tenant-scoping convention, every query has to be inspected manually to confirm it's reading the right slice of data. With it, the query layer enforces correctness by construction.

## Decision

**Every persistent record carries a `tenant_id` column. Every read and write goes through a tenant-aware query layer that refuses to issue tenant-less queries.**

Concretely:

1. **Every table** that holds operator-controlled data has a `tenant_id` column, indexed.

2. **The query builder** rejects queries without `tenant_id` at compile time where TypeScript's type system permits; otherwise at runtime via assertion. Code that wants to bypass this requires an explicit `unsafelyAcrossTenants()` escape hatch that's grep-able and discouraged.

3. **Vector store collections** are namespaced by `tenant_id` prefix. A campaign's cold-knowledge embeddings live in a tenant-specific collection.

4. **The default tenant** for a fresh Skeinkeeper install is `"default"`. The operator creates additional tenants only if they want to run multiple isolated campaign groups in the same instance.

5. **The orchestrator code path never branches on tenant identity.** Tenant ID flows through request context; behavior is identical regardless of value.

6. **Cross-tenant access is impossible by design.** There is no query path that reads from multiple tenants simultaneously. Operations that need to span tenants (e.g., a global metric across all the operator's campaigns) are implemented as separate per-tenant queries with application-level aggregation.

## Consequences

**Positive**
- **Multiple campaign groups in one install just work**, with no risk of state mixing.
- **Code is easier to review.** A reviewer reading a query knows immediately what scope it operates in.
- **Backup and restore are scoped.** Exporting one campaign group's data doesn't leak another's.
- **Bugs that would cross tenants are caught at compile time.** A common class of leak-through-aggregation bugs is structurally impossible.
- **The convention scales.** If the operator ever runs more campaign groups, the architecture doesn't change.

**Negative**
- **Engineering discipline cost.** Every query reviewer has to confirm tenant scoping. CI lint helps but doesn't catch everything.
- **The constant value `"default"`** can confuse newcomers ("why is this column always the same value?"). The CONTRIBUTING guide explains it.
- **A small storage overhead** (the column itself, the index). Negligible.

**Neutral**
- This is a standard pattern in software that may host multiple isolated workloads. The discipline is well-understood; we're following convention.
- SQLite is sufficient for the OSS scale; Postgres with row-level security would also implement this cleanly if scale ever required it.

## Hard rules implied by this ADR

These become CI checks or lint rules:

1. **No raw SQL against tenant-scoped tables.** All queries route through the tenant-aware builder.
2. **The `tenant_id` column exists on every operator-data table.** A migration test verifies it.
3. **The `unsafelyAcrossTenants()` escape hatch is rare and reviewed.** Every use case requires explicit code-review approval.

## What this ADR does NOT decide

- The exact schema design (column types, foreign keys, etc.). That's in design docs.
- Whether to use SQLite or Postgres long-term. SQLite for now; revisit if scale changes.
- How tenants are created or destroyed at the operator-facing level. That's an operator-UX question handled in design docs.

## Revisit when
- A pattern of cross-tenant operations becomes legitimately useful and the escape hatch is being invoked frequently.
- A different multi-tenancy model becomes clearly superior. Unlikely; this is the standard pattern.
- The discipline cost in contributor experience turns out to be higher than expected.
