# Design Doc 0003: Erasure and Export

> Status: Accepted
> Author: maintainers
> Date: 2026-05-19
> Related ADRs: [ADR-0010 (privacy as architecture)](../adr/0010-privacy-as-architecture.md)
> Related design docs: [0002 (privacy foundation)](./0002-privacy-foundation.md)

## Context

ADR-0010 commits the project to giving operators self-service data deletion and export. Every persistent data store must register a way to participate in those flows; that's how "the operator can answer 'did we honor that erasure request?'" stays verifiable as the codebase grows.

The acceptance for Phase 0.7 calls for:

1. A single typed interface every storage adapter implements.
2. Central services (`ErasureService`, `ExportService`) that orchestrate calls across all registered adapters.
3. Audit trail to `deletion_log` for every erasure.
4. CLI commands the operator can invoke (`player:delete`, `player:export`, `campaign:delete`, `campaign:export`).
5. A hard-rule entry in `CONTRIBUTING.md`: new persistent storage requires a registered deletion adapter before merge.

This design covers all of that. Encryption-at-rest for PII columns (per design 0002) is *not* implemented here — the consents adapter writes/reads in cleartext for now; encryption ships when the OS-keyring integration is built out.

## Decision

### Scope type

Erasure and export both fan out over the same three scopes; modeling them as a discriminated union keeps the adapters honest about what they support.

```ts
export type ErasureScope =
  | { kind: "player"; tenantId: string; subjectId: string }     // a Discord user
  | { kind: "campaign"; tenantId: string; campaignId: string }  // one campaign's data
  | { kind: "tenant"; tenantId: string };                        // full wipe
```

### Deletion adapters

```ts
export interface DeletionAdapter {
  readonly name: string;                              // e.g., "consents"
  readonly supportedScopes: ReadonlyArray<ErasureScope["kind"]>;
  delete(scope: ErasureScope): Promise<number>;       // returns records deleted
}
```

The `supportedScopes` declaration lets `ErasureService` skip adapters that don't apply to the current scope. Consents support `player` and `tenant` but not `campaign` (consents aren't campaign-scoped). The audit log, when it lands, will support only `tenant` (the audit log itself is part of the audit trail and isn't erased on player erasure).

### ErasureService

```ts
export class ErasureService {
  register(adapter: DeletionAdapter): void;
  async erase(scope: ErasureScope): Promise<ErasureReport>;
}

export interface ErasureReport {
  scope: ErasureScope;
  perAdapter: ReadonlyArray<{ adapter: string; recordsDeleted: number }>;
  totalRecords: number;
}
```

For each registered adapter that supports the scope, the service calls `delete(scope)`, captures the count, and writes one `deletion_log` row per adapter with the salted hash of the subject (or campaign ID, or null for tenant scope).

The deletion_log writes never carry the raw subject ID. The salt is per-installation; it's read from the keyring at boot. For alpha, a per-installation file at `data/.salt` is generated on first run if absent.

### Export adapters

Symmetric shape:

```ts
export interface ExportAdapter {
  readonly name: string;
  readonly supportedScopes: ReadonlyArray<ErasureScope["kind"]>;
  export(scope: ErasureScope): Promise<ExportPayload>;
}

export interface ExportPayload {
  /** Structured data for the JSON archive. Plain objects only; no class instances. */
  data: unknown;
  /** Optional human-readable summary lines for the HTML summary page. */
  summary?: ReadonlyArray<string>;
}
```

`ExportService` aggregates per-adapter payloads into:

- `<subject-or-campaign-id>.export.json` — a top-level JSON object with one key per adapter name.
- `<subject-or-campaign-id>.export.html` — a static HTML page listing what was exported, with the JSON inline and the per-adapter summary lines. Operator-readable; lets a player confirm they got their data without parsing JSON.

### CLI

Single `skeinkeeper` binary, sub-command routing via `node:util` `parseArgs`. Commands for the alpha:

```
skeinkeeper player:export   --tenant <id> --subject <discord-id>  [--out <dir>]
skeinkeeper player:delete   --tenant <id> --subject <discord-id>
skeinkeeper campaign:export --tenant <id> --campaign <id>          [--out <dir>]
skeinkeeper campaign:delete --tenant <id> --campaign <id>
skeinkeeper tenant:delete   --tenant <id>                          # full wipe; confirms
```

Defaults: `--tenant default` (the OSS default tenant), `--out ./exports/`. Delete commands without `--yes` prompt for confirmation; with `--yes` they execute immediately.

The CLI lives in `server/src/cli.ts`. A thin wrapper at `scripts/skeinkeeper.mjs` invokes it so `pnpm skeinkeeper ...` from the repo root works during alpha. A proper bin distribution (so `npx skeinkeeper ...` works from outside the repo) is a v0.5 packaging concern.

### Contributor hard rule

Adding the following sentence to `CONTRIBUTING.md`:

> **Any PR that adds a new persistent data store (table, file, vector collection) must also register a `DeletionAdapter` for it under `server/src/adapters/` before merge.** Reviewers will reject otherwise. The mechanism is `ErasureService.register(adapter)` per design doc 0003.

## Alternatives considered

- **One generic `delete(tenantId, subjectId, kind)` method instead of a discriminated union.** Rejected: the kind=campaign case takes a different ID than kind=player. The discriminated union makes the adapter API self-documenting; a generic signature pushes that information into runtime checks.
- **No CLI; web UI only.** Rejected for alpha: the web UI is deferred to v0.5, so the CLI is what the operator has during alpha.
- **No HTML summary; JSON only.** Rejected: a player asking "what data do you have on me?" deserves to read it without opening a text editor. The HTML summary is cheap; it's a static page with embedded JSON.

## Telemetry implications

The `error.captured` event already covers adapter failures. No new events.

## Privacy implications

- The deletion-log writes use the salted hash, not the raw ID. The deletion log carries no recoverable PII even after this lands.
- Export payloads contain the raw user data the operator already has access to — they're a packaging of existing local data, not a new disclosure surface.
- The HTML summary inlines the JSON for the player's convenience. Operator should hand it over via a private channel (DM, email); we don't take responsibility for the transport.

## Eval implications

None — mechanical infrastructure with unit and integration tests.

## Open questions

- **Soft delete vs hard delete.** Currently `delete` is destructive. A soft-delete mode (mark-and-sweep with a recovery window) might be useful for "oops I deleted my own data." Defer to v0.5 if requested.
- **Cross-tenant export.** Out of scope for alpha; operators run a single tenant.
- **Backup-aware deletion.** If the operator backs up the data directory, deletion doesn't reach the backups. Document this in PRIVACY.md as an operator responsibility.
