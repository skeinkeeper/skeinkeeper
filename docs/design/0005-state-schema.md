# Design Doc 0005: State Schema

> Status: Accepted
> Author: maintainers
> Date: 2026-05-19
> Related ADRs: [ADR-0002 (four-tier memory)](../adr/0002-four-tier-memory-model.md), [ADR-0003 (tool-call-only mutation)](../adr/0003-tool-call-only-state-mutation.md), [ADR-0008 (tenant scoping)](../adr/0008-tenant-scoping.md), [ADR-0010 (privacy as architecture)](../adr/0010-privacy-as-architecture.md)
> Related design docs: [0002 (privacy foundation)](./0002-privacy-foundation.md)

## Context

Per ADR-0002, the **warm tier** of memory lives in a structured database. Per ADR-0003, every mutation goes through typed tool calls — not free text. Per ADR-0008, every row carries `tenant_id` and cross-tenant queries don't compile. This design codifies the schema and the data-access shape that enforces those properties.

The tables here cover what the orchestrator and tool dispatcher need to read and write during a session. Cold-tier content (campaign text, SRD rules) and episodic memory live in LanceDB and ship in Phase 4.

## Decision

### Tables

All tables are SQLite via Drizzle. Every operator-data table carries `tenant_id`. Foreign keys reference parent tables (no `tenant_id` denormalization for FKs because the parent already carries it; cross-tenant FKs are blocked at query time by the wrapper).

| Table | Purpose | Mutated via |
|---|---|---|
| `tenants` | Tenant directory; default install has `{ id: "default" }`. | Operator CLI |
| `campaigns` | One row per active campaign within a tenant. | Operator CLI / web UI |
| `characters` | Player characters. `player_discord_id` is PII. | Tool calls + operator |
| `npcs` | Named NPCs. Carries the three things from behavior spec §3 (mannerism, motivation, secret) plus disposition and voice. | Tool calls + operator |
| `locations` | Named locations with optional hierarchy. | Tool calls + operator |
| `quest_flags` | String-keyed campaign state (`"phandelver.cragmaw.cleared" = "true"`). | Tool calls |
| `faction_reputation` | Per-faction integer reputation. | Tool calls |
| `sessions` | One row per gameplay session. | Orchestrator |
| `audit_log` | Every tool call, state mutation, and AI decision. Append-only. | Tool dispatcher |

`audit_log` rows are append-only by convention; no `UPDATE` or `DELETE` against this table outside the erasure flow.

### Tenant-aware access: `TenantDb`

The schema lives in `server/src/schema/`. The `Db` type from `server/src/db.ts` is exported for migration use but **not** for application use. Application code receives a `TenantDb` instance:

```ts
export class TenantDb {
  constructor(private readonly db: Db, public readonly tenantId: string) {}

  campaigns = {
    list: () => /* SELECT … WHERE tenant_id = ? */,
    get: (id: string) => /* … WHERE tenant_id = ? AND id = ? */,
    create: (data: NewCampaign) => /* INSERT with tenant_id forced */,
  };
  characters = { /* … */ };
  // …per table.

  /** Escape hatch — grep-able and code-review-gated. Use only for
   *  migrations and operator-wide tooling. */
  unsafelyAcrossTenants<T>(fn: (db: Db) => T): T { return fn(this.db); }
}
```

Compile-time enforcement: the orchestrator, plugins, and CLI receive `TenantDb` from the bootstrap layer, not `Db`. ESLint's `no-restricted-imports` blocks direct imports of `@skeinkeeper/server/schema` outside the server package — same pattern that already gates the telemetry SDKs. The escape hatch is grep-able (`unsafelyAcrossTenants`) so code review catches its use.

This isn't a perfect compile-time barrier — a determined contributor could re-export the schema, or reach into the wrapper. The combination of (a) the typed wrapper, (b) the lint rule, and (c) code review is what ADR-0008 calls for in practice. Stronger enforcement (e.g., per-tenant schema objects in Drizzle, or row-level security if we move to Postgres) is a v0.5+ option.

### Foreign keys and indexes

- Every `WHERE tenant_id = ?` query is indexed via composite indexes (e.g., `characters(tenant_id, campaign_id)`).
- FKs use `ON DELETE CASCADE` where the parent's deletion implies the child's (e.g., deleting a campaign deletes its characters). This matches the erasure flow from design doc 0003.
- `audit_log` does *not* cascade on parent deletion — it must be erased explicitly via the `audit_log` deletion adapter that lands with this task, otherwise it stays as the audit trail.

### Seed data

`server/src/seed.ts` reads from `data/seed.yaml` if present and inserts a `default` tenant plus whatever the file declares. A committed `data/seed.example.yaml` shows the structure; `data/seed.yaml` itself is gitignored (it would contain the operator's real Discord IDs).

## Alternatives considered

- **Per-tenant separate databases.** Cleaner isolation, but operational complexity multiplies (backup-restore semantics, migration coordination). For alpha's single-operator case, single DB with tenant scoping is right.
- **Normalize ruleset-specific fields out of `characters`.** Rejected for now: D&D 5e is the only ruleset at alpha. When a second ruleset lands (v2+), `characters.ruleset_data_json` splits into per-ruleset tables — manageable migration.
- **Row-level security via Postgres at alpha.** Premature — SQLite is the OSS default. RLS is a v0.5+ consideration if Postgres becomes the default for any deployment.

## Telemetry implications

The `tool.called` event from the telemetry registry already covers tool-driven mutations. No new events here.

## Privacy implications

- `characters.player_discord_id` carries PII. Encryption-at-rest applies once the encryption shim lands (deferred per design doc 0002).
- `audit_log` may include PII via tool-call payloads (e.g., a `whisper` target's Discord ID). The audit_log deletion adapter that ships with this task drops audit rows on tenant erasure but not on per-player erasure (per design 0003: audit log is part of the audit trail).
- A new deletion adapter (`AuditLogAdapter`) is registered with `ErasureService` for tenant scope.
- A new deletion adapter (`CampaignAdapter`) is registered for campaign scope; deleting a campaign cascades to its characters, npcs, locations, quest_flags, faction_reputation, and sessions via FK CASCADE.

## Eval implications

None — mechanical schema. Behavior fixtures land in Phase 1.6 onwards.

## Open questions

- **Soft delete for sessions.** Currently sessions are hard-deleted with their campaign. Should the operator be able to retain session transcripts for canceled campaigns? Defer to v0.5.
- **Compound primary keys for audit_log.** If the table grows large, partitioning by month would help. Defer; SQLite handles millions of rows in a single table fine for alpha.
- **JSON validation at the application layer.** Drizzle stores JSON columns as text; we should validate via Zod on write. Defer to Phase 1.2 (tool registry) since most writes will originate there.
