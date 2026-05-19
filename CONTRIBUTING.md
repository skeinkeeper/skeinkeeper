# Contributing to Skeinkeeper

Thanks for your interest in contributing. This document covers how to set up a dev environment, how the project's conventions work, and how to submit changes.

## Getting started

### Dev environment

Skeinkeeper is a TypeScript monorepo using pnpm workspaces. You'll need:

- Node.js 22 or later
- pnpm 9 or later (`npm install -g pnpm`)
- Docker and docker compose (for running the full stack locally)
- A Discord bot token, Foundry instance, and API keys for any providers you want to exercise

```bash
git clone https://github.com/skeinkeeper/skeinkeeper.git
cd skeinkeeper
pnpm install
cp .env.example .env
# edit .env with your credentials
pnpm dev
```

### Running tests

```bash
pnpm test                 # Unit tests
pnpm eval                 # Behavior evaluation fixtures
pnpm lint                 # ESLint + Prettier check
pnpm type-check           # TypeScript compile check
```

All of these run in CI on every PR. Merges require green checks.

## How we work

### Read the architecture first

Before making non-trivial changes, read:

- [`CLAUDE.md`](./CLAUDE.md) for the project's conventions and architectural rules
- [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) for the high-level overview
- The relevant [Architecture Decision Records](./docs/adr/) for any subsystem you're touching

These documents represent decisions the project has made and the reasoning behind them. If you find yourself wanting to do something that contradicts them, that's a signal to start a discussion (GitHub Issue) rather than just submitting a PR.

### Architectural reviews at phase boundaries

Before starting work on a new development phase (or a substantial new subsystem), take a short architectural review pass: re-read the relevant ADRs and design docs; check whether the assumptions made in earlier phases still hold; look at whether new dependencies, OSS alternatives, or upstream learnings have surfaced. Pause to question before building. Architectural mistakes compound across phases — the cost of changing direction one message into a refactor is much smaller than the cost of unwinding decisions after a phase has built on top of them.

ADRs and design docs are accepted decisions, not immutable ones. If new information shows that an earlier decision was wrong (a dependency's license, a competitor's better approach, a constraint that wasn't visible at the time), say so and propose the revision in a new design doc or a superseding ADR.

### Design-doc-first for non-trivial changes

For any change that meets at least one of these criteria, write a design doc in `/docs/design/` and get it reviewed before writing implementation code:

- More than ~100 lines of code
- Touches more than one module
- Introduces a new external dependency
- Changes a data model
- Introduces new processing of personal data

A design doc template lives at `/docs/design/TEMPLATE.md`. Small bug fixes, refactors, and obvious tweaks don't need this.

The "design doc, then code" flow saves time on both sides: maintainers can catch architectural mismatches before you've invested in implementation, and you don't risk having a substantial PR rejected for a structural reason.

### Behavior changes go in `/behavior/default.md`

The AI DM's behavior — how it narrates, when it calls for rolls, how it handles NPCs — lives in [`behavior/default.md`](./behavior/default.md), not in code. Per [ADR-0006](./docs/adr/0006-behavior-spec-separate-doc.md), this is a versioned prompt asset treated like code.

If you want to change what the AI does (rather than what the platform supports), the change goes in the behavior spec, not in source files. Behavior changes require eval fixtures demonstrating the impact.

### One task per PR

PRs should be small enough to review in ten minutes. If your change has multiple concerns, split them. A PR that does feature A, refactors module B, and adds dependency C is three PRs.

### Tests alongside features

Every PR includes:

- Unit tests for new deterministic logic
- Eval fixtures for new behavioral logic
- Telemetry event definitions for new user-visible features
- Deletion-path tests for any new persistent storage

### New persistent storage requires a DeletionAdapter

Any PR that adds a new persistent data store (table, file, vector collection) must also register a `DeletionAdapter` for it under `server/src/adapters/` before merge. Reviewers will reject otherwise. The mechanism is `ErasureService.register(adapter)` per [design doc 0003](./docs/design/0003-erasure-and-export.md). The same applies to `ExportAdapter` so the new data shows up in operator exports.

### Commits

We use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(orchestrator): add tool-call retry with exponential backoff
fix(plugins/voice-discord): handle disconnected players gracefully
docs(adr): add ADR-0011 on rate limiting
```

All commits require a DCO sign-off (`Signed-off-by:` line). Configure your git client to add this automatically:

```bash
git commit -s -m "your commit message"
```

Or set up a global alias to make `git commit` always sign off.

## Code style

- TypeScript strict mode
- Functional core, imperative shell — pure functions where possible, side effects at the edges
- `camelCase` for variables and functions, `PascalCase` for types and classes, `SCREAMING_SNAKE_CASE` for constants
- One exported concept per file; co-locate tests as `*.test.ts`
- Path aliases via `tsconfig` — no `../../../` chains

## Working with AI coding tools

This project commits a [`CLAUDE.md`](./CLAUDE.md) file at the root with project-specific guidance for Claude Code and similar agentic dev tools. Using such tools is entirely optional; the `CLAUDE.md` is there for contributors who want to.

If you're using Claude Code or similar, the file tells the tool about the project's conventions, hard rules, and where to find the canonical documentation. It will save you time getting oriented.

## Plugin contributions

The four plugin interfaces are the main contribution surface for new providers:

- `LLMProvider` — for a new model provider (OpenAI, Grok, Gemini, local models)
- `Ruleset` — for a new TTRPG ruleset (Pathfinder 2e, Call of Cthulhu, etc.)
- `VTTDriver` — for a new virtual tabletop (Owlbear Rodeo, Roll20, etc.)
- `VoiceIO` — for a new transport or voice stack

See [ADR-0004](./docs/adr/0004-plugin-interface-pattern.md) for the architectural pattern. Implementations live in `/plugins/{kind}-{name}/`.

When proposing a new plugin, open an issue first to discuss scope. A good plugin proposal covers: which interface, what the implementation depends on (external APIs, licenses), and how it'll be tested.

## What's not currently accepted

To keep scope manageable for the alpha, the following are not currently accepted:

- New rulesets beyond D&D 5e (deferred to v2+)
- New VTTs beyond Foundry (deferred to v2+)
- Major changes to the four-tier memory model (high coordination cost; raise an issue first)
- Changes to commercial content handling — Phandelver content stays operator-supplied per [ADR-0007](./docs/adr/0007-phandelver-content-operator-supplied.md)

This will open up as the project matures.

## Code of conduct

Be kind. Be patient with new contributors. Disagree with ideas, not people. Assume good faith. The maintainers reserve the right to remove participants who behave badly toward others in the project's spaces.

## License

By contributing, you agree that your contributions will be licensed under the Apache License 2.0, the same as the rest of the project.
