# Skeinkeeper — Project Memory for AI Coding Tools

> _Wyrd bið ful aræd._

This file gives AI coding assistants (Claude Code, similar tools) project-specific context for working in this repository. If you're not using such a tool, you can ignore this file — `CONTRIBUTING.md` is the right starting point for humans.

---

## What this project is

Skeinkeeper is a self-hosted, open-source AI Dungeon Master. A friend group runs it on one operator's machine; the AI joins their Discord voice channel and runs tabletop RPG campaigns over Foundry VTT. The operator brings their own Discord bot token, their own Foundry instance, and their own LLM/voice provider API keys.

Current milestone: pre-MVP alpha. The reference deployment is the founder's hybrid table running Lost Mine of Phandelver.

## Canonical documents

Read these before generating non-trivial code. They are the source of truth.

- **`/behavior/default.md`** — how the AI DM conducts itself at the table. Loaded as the AI's system prompt at runtime. The most important document for AI-DM quality.
- **`/docs/adr/`** — architectural decisions. Read the index (`INDEX.md`) and the relevant ADR before changing anything that touches an established decision.
- **`/docs/ARCHITECTURE.md`** — high-level overview of how the pieces fit together.
- **`/docs/PRIVACY.md`** — what data is stored where, how deletion works, how operators communicate with players.
- **`CONTRIBUTING.md`** — contributor onboarding, dev environment, PR process.

If a request involves something not covered in these documents, ask whether to write a TDD or update an existing one before generating code.

## Hard rules (architectural)

These are enforced via lint, CI, or code review. Violations are not negotiable.

1. **All state mutations and dice rolls go through typed tool calls** ([ADR-0003](./docs/adr/0003-tool-call-only-state-mutation.md)). The LLM never mutates state via free text.

2. **All persistent data is scoped by `tenant_id`** ([ADR-0008](./docs/adr/0008-tenant-scoping.md)). Queries that don't carry a tenant ID don't compile. Use the tenant-aware query builder; never write raw SQL against tenant tables.

3. **Telemetry is off by default and routes through the typed wrapper** ([ADR-0009](./docs/adr/0009-telemetry-opt-in.md)). No PII or content in product analytics events — types refuse to let you. Direct SDK calls outside `/telemetry` are lint errors.

4. **No Foundry-specific or LLM-provider-specific code outside the respective driver** ([ADR-0004](./docs/adr/0004-plugin-interface-pattern.md)). The orchestrator talks to interfaces, not implementations.

5. **Behavior changes go in `/behavior/default.md`, not in code.** If a request involves changing what the AI DM says or does, the answer is usually a behavior change with a corresponding eval fixture, not a code change. See [ADR-0006](./docs/adr/0006-behavior-spec-separate-doc.md).

6. **No commercial campaign content in the repo** ([ADR-0007](./docs/adr/0007-phandelver-content-operator-supplied.md)). Phandelver and other WotC content is operator-supplied. SRD content (CC-BY-4.0) is OK.

7. **Never inline secrets.** API keys, tokens, credentials — all via environment variables in dev, OS keyring or libsodium-sealed config in production. CI rejects PRs with secret-shaped strings.

8. **Privacy by design** ([ADR-0010](./docs/adr/0010-privacy-as-architecture.md)). Every persistent data store has a documented deletion path. Every PII field is annotated with the `PII<>` type marker. Voice audio is strictly ephemeral. PRs that add new storage require a deletion adapter before merge.

9. **Don't reinvent abstractions an integrated dependency already provides.** Before designing a new plugin interface or schema layer, check whether a system we're integrating with already provides it. The clearest example: Foundry's per-system data models _are_ the ruleset abstraction — we don't build a parallel one. If we find ourselves designing an interface that mirrors a system we already depend on, use theirs instead.

10. **Evaluate alternatives before committing to a third-party dependency.** Every new dependency added in a TDD or ADR must list at least one evaluated alternative, with explicit notes on licensing, cost, and maintenance posture. Prefer fully-OSS, self-hostable options. Patreon-gated, subscription-gated, or single-vendor-hosted dependencies require a written justification, not silent inclusion.

## Hard rules (process)

11. **TDD before code for any non-trivial feature.** "Non-trivial" = more than ~100 lines, or touches more than one module, or introduces a new external dependency, or changes a data model, or introduces new processing of personal data. The TDD lives in `/docs/tdd/` and is reviewed before implementation begins. For small bug fixes and refactors, skip this.

12. **Tests alongside features, not after.** Every PR includes:

- Unit tests for new deterministic logic (dice, state mutations, parsing).
- Eval fixture for new behavioral logic (anything the LLM does).
- Telemetry event reference for any new user-visible feature (even though events fire only when opted in).
- Deletion-path test for any new persistent storage.

13. **One task per PR.** PRs reviewers can read in ten minutes or less.

14. **Plan mode for anything ambiguous.** If the request is open to interpretation, produce a plan and confirm before writing code. Better to ask once than to rewrite twice.

15. **Docs update alongside the code that breaks them.** When a code change makes any of these stale — an ADR's substance, a TDD's claims, [`README.md`](./README.md), [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md), [`docs/PRIVACY.md`](./docs/PRIVACY.md), [`docs/INSTALL.md`](./docs/INSTALL.md), [`CONTRIBUTING.md`](./CONTRIBUTING.md), this file, [`behavior/default.md`](./behavior/default.md), or schemas/configs that doc examples reference (`.env.example`, `data/seed.example.yaml`) — the doc update is part of the same PR. Not a follow-up commit, not a TODO, not a "sweep later." Before treating a task as complete:
    - List every doc/example/comment that names a concept you changed (deleted tables, renamed types, dropped tools, swapped dependencies, revised flows). Use `grep` or a search agent — don't rely on memory.
    - For ADRs/TDDs in `Accepted` status, follow hard rule #15-adjacent: supersede with a new doc, don't rewrite substance in place (see [hard rule about ADR immutability](#hard-rules-process) and [CONTRIBUTING.md](./CONTRIBUTING.md)).
    - For evergreen user-facing docs (README, ARCHITECTURE, PRIVACY, INSTALL, CONTRIBUTING, behavior spec), edit in place.
    - Include the doc changes in the same commit when they're small (typo, link fix, one-line correction); split them into a second commit in the same PR when the doc work is substantial (a rewrite, a new ADR). The PR doesn't land until docs catch up.

    Past example: the Foundry-as-source-of-truth refactor changed schemas, dropped tables, swapped a recommended dependency — and shipped without touching README, ARCHITECTURE, PRIVACY, or CONTRIBUTING. A separate doc-sanity-sweep had to be done days later. That sweep should have been part of the refactor PR. Avoid the lag.

## Tech stack

- **Language:** TypeScript end-to-end (Node 22+). The local web console is plain Node `http` + static assets — no web framework.
- **Database:** SQLite. Tenant-scoped tables per [ADR-0008](./docs/adr/0008-tenant-scoping.md).
- **Vector store:** LanceDB. Per-tenant namespaces.
- **Auth:** Local password + optional WebAuthn passkey. No remote auth.
- **LLM:** Anthropic Messages API (Claude) as default. Other providers via the plugin interface per [ADR-0004](./docs/adr/0004-plugin-interface-pattern.md).
- **Discord bot:** discord.js v14+, with `@discordjs/voice` for audio. The operator runs their own bot under their own token.
- **Voice:** Deepgram (STT, default), ElevenLabs (TTS, default). Plugin-swappable. Operator brings their own API keys.
- **Foundry integration:** OSS Foundry MCP bridge ([ADR-0011](./docs/adr/0011-prefer-oss-foundry-mcp-bridges.md), superseding [ADR-0001](./docs/adr/0001-use-foundry-mcp-for-vtt.md)) — consume, don't reimplement.
- **Observability (local):** structured logging to file. Langfuse for LLM tracing (operator-configured if desired).
- **Observability (opt-in remote):** PostHog (product analytics), Sentry (errors), both off by default per [ADR-0009](./docs/adr/0009-telemetry-opt-in.md).
- **Deployment:** `docker compose up`. Web UI served on `localhost:3000`.
- **CI:** GitHub Actions. Required checks: lint, type-check, unit tests, eval harness, telemetry-event-registry validation.
- **License:** Apache 2.0 per [ADR-0005](./docs/adr/0005-apache-2-license.md).

## Conventions

**Code style:**

- TypeScript strict mode. No `any` without an explicit `// eslint-disable-next-line` and a comment explaining why.
- Functional core, imperative shell. Pure functions wherever possible; side effects at the edges.
- Names: `camelCase` variables and functions, `PascalCase` types and classes, `SCREAMING_SNAKE_CASE` constants.
- Files: one exported concept per file; co-locate tests as `*.test.ts`.

**Imports:**

- Path aliases via `tsconfig`. No `../../../` chains.
- Group order: external packages, internal modules, types, then relative.

**Errors:**

- Domain errors are typed (`Result<T, E>` or tagged unions). Don't throw from business logic.
- HTTP boundaries convert errors to typed responses; no leaked stack traces.
- All errors emit a typed telemetry event (anonymous; fires only when opted in).

**Comments:**

- Code comments explain _why_, not _what_. The _what_ should be obvious from the names.
- Reference the relevant ADR for non-obvious decisions: `// per ADR-0003: state via tool calls only`.
- TODOs reference an issue number: `// TODO(#142): handle disconnected players gracefully`.

**Commits:**

- Conventional Commits format: `type(scope): summary`. Types: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`, `perf`.
- Body explains the why if it's not obvious from the summary.
- DCO sign-off (`Signed-off-by:` line) on commits.

## Repository structure

```
/
├── CLAUDE.md                    # This file.
├── README.md                    # User-facing readme.
├── LICENSE                      # Apache 2.0.
├── CONTRIBUTING.md              # Contributor onboarding.
├── /behavior/
│   └── default.md               # The AI DM's system prompt (versioned as code).
├── /docs/
│   ├── ARCHITECTURE.md          # High-level overview.
│   ├── PRIVACY.md               # User-facing privacy explanation.
│   ├── /adr/                    # Architectural decision records.
│   └── /tdd/                     # Technical design docs (TDDs).
├── /orchestrator/               # Core LLM orchestration, memory, tool dispatch.
│   └── /interfaces/             # Plugin interfaces.
├── /plugins/
│   ├── /llm-anthropic/          # Anthropic LLM provider.
│   ├── /vtt-foundry/            # Adapter over the Foundry MCP bridge.
│   ├── /voice-discord/          # Discord + Deepgram + ElevenLabs.
│   ├── /embed-local/            # Local (on-box) embedding provider.
│   └── /memory-lance/           # LanceDB cold/episodic store + erasure adapter.
│                                # NB: no ruleset plugin — Foundry's per-system
│                                # module IS the ruleset abstraction (ADR-0012,
│                                # hard rule #9). Rules knowledge comes from the
│                                # model + retrieved SRD/compendium content.
├── /telemetry/                  # Typed event emission wrapper + event registry.
├── /app/                        # Operator app: Discord gateway + voice loop + web console.
├── /server/                     # Local DB, schema, auth, secret storage, erasure/export.
├── /eval/                       # Eval harness + fixtures.
└── /scripts/                    # Dev/ops + live-validation utilities.
```

## How to run things

```bash
# Local dev
pnpm install
pnpm dev                  # Watches everything, starts orchestrator + web.

# Tests
pnpm test                 # Unit tests across all packages.
pnpm eval                 # Scripted eval harness (deterministic; model faked).
pnpm eval:live            # Fixtures vs. the real model (needs ANTHROPIC_API_KEY; not in CI).
pnpm lint                 # ESLint + Prettier check.

# Production (operator-facing)
docker compose up         # Runs the whole stack; web UI at localhost:3000.
```

## Repo gates

Before treating a change as done, satisfy the gates CI enforces — easiest via the
single command `pnpm verify:all` (headers + telemetry registry + lint + type-check

- tests + eval). The individual gates:

* **SPDX header** on every committed source file (`.ts/.tsx/.js/.mjs/.cjs` under
  the code dirs) — the two lines in [`LICENSE-HEADER.txt`](./LICENSE-HEADER.txt).
  CI's `check:headers` fails the PR without it.
* **DCO sign-off** on every commit. No need for `git commit -s`: a
  `prepare-commit-msg` hook auto-appends `Signed-off-by:` from your git identity
  (set `git config user.name` / `user.email` if it's missing).

Detached `/implement` builds run in a fresh git worktree; dependency install there
is handled automatically by the build runner.

## Anti-patterns — never do this

- **Stuffing more state into the LLM prompt because retrieval is broken.** Fix retrieval. The prompt is for transient context.
- **Adding a flag instead of fixing the prompt.** If the model needs a flag to behave correctly, the Behavior Spec is wrong; fix the spec.
- **Adding "manual override" features without a corresponding audit log entry.** Every override is auditable.
- **Phoning home from anywhere by default.** Telemetry is opt-in, no exceptions.
- **Putting business logic in webhook handlers.** Webhooks dispatch to queues; queues run the work; results emit events.
- **Writing free-form prose into the audit log.** Audit log entries are structured events. Free-form prose goes into the AI's chat output, not the audit log.
- **Asking the LLM to do math.** Math goes through a tool. Always.
- **Rolling dice in the model.** Per ADR-0003.
- **Generating example data with PII-shaped strings** even in tests. Use `fake-` prefixed values.
- **Adding an operator control to only one surface.** Every operator action/setting must work from _both_ the web console and **Foundry chat commands** (`/skeinkeeper <verb> <args>`), and stay synced live across them (one `SessionManager` write path + an `AppEvent` on the bus). Per [ADR-0028](./docs/adr/0028-operator-control-parity-foundry-chat.md) (supersedes [ADR-0016](./docs/adr/0016-operator-control-parity-across-surfaces.md)) / [TDD 0040](./docs/tdd/0040-operator-control-parity-foundry-chat-commands.md) (supersedes [TDD 0025](./docs/tdd/0025-operator-control-parity.md)). Discord is voice + one-time consent only ([ADR-0025](./docs/adr/0025-foundry-as-table-text-and-operator-surface.md)); do not add operator controls to Discord slash commands. Per-player actions like `/skeinkeeper consent` are exempt (not operator controls).

## When responding to user requests

- **Read the relevant ADRs first** for any non-trivial request. Reference what we already decided.
- **Default to a TDD for non-trivial work.** Produce the doc, get explicit approval, then implement.
- **Default to plan mode for ambiguous requests.** Show the plan, get approval, then execute.
- **One task per PR; one decision per ADR; one design per TDD.** Composition happens by reference, not by stuffing.
- **Surface trade-offs honestly.** If the requested approach has downsides, name them. Don't hide problems to feel agreeable.
- **Stop and ask if a request would violate a hard rule.** Don't try to find a clever way around the rules.

---

_This file is project memory. Update it when conventions change._
