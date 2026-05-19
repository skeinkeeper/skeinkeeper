# ADR-0001: Use the Foundry MCP Module for VTT Integration

## Status
Proposed (2026-05-17). **Superseded by [ADR-0011](./0011-prefer-oss-foundry-mcp-bridges.md) (2026-05-19)** — the recommendation of the Patreon-gated `alexivenkov` bridge was reversed once fully-OSS alternatives were surveyed. The historical content below is preserved unchanged.

## Context

The AI DM must operate Foundry VTT autonomously — moving tokens, managing combat, rolling dice, controlling scenes, applying conditions, and so on. Implementing this from scratch is a substantial undertaking: Foundry's API is large, version-sensitive, and changes meaningfully across major releases (v11 → v12 → v13 → v14).

A community-maintained module, **Foundry API Bridge / Foundry MCP** (by `alexivenkov`), already exposes approximately 71 commands covering the surface area we need: scenes, tokens, actors, items, effects, combat tracker, dice rolling, chat, journals, and compendium access. It speaks the Model Context Protocol natively and is compatible with Foundry v11–v13.

Building our own equivalent would consume an estimated 4–6 weeks of effort that delivers zero player-facing value beyond what the existing module provides.

## Decision

For v1, the **`VTTDriver` for Foundry is implemented as a thin adapter over the Foundry MCP module.** We consume it as a third-party dependency. We do not fork or reimplement.

The adapter normalizes the MCP commands into our internal `VTTDriver` interface, so that future VTT drivers (Roll20, Owlbear Rodeo, native Foundry alternative) implement the same shape.

## Consequences

**Positive**
- Foundry integration is largely "done" on day one. Engineering time redirects to the harder problems: orchestration, memory, and behavior.
- The community module benefits from its own contributor base — bug fixes and Foundry-version compatibility updates flow in for free.
- The MCP surface is already designed to be AI-consumable; we don't have to invent that abstraction.

**Negative**
- We take on a third-party dependency whose roadmap we don't control. If the maintainer abandons it or makes breaking changes, we inherit the cost.
- We're constrained by the commands the module exposes. Capabilities outside that surface require either upstreaming a contribution, forking, or implementing direct Foundry calls alongside the bridge.
- The module currently requires an API key issued via Patreon. This creates a non-free dependency for some users and a soft licensing question for an OSS project. Mitigation: document the dependency clearly; revisit if it becomes a barrier.

**Neutral**
- The `VTTDriver` abstraction means we can later replace the implementation without affecting the orchestrator. The MCP module is the **implementation**, not the **interface**.
- We should contribute back to the Foundry MCP project where useful (bug reports, command additions). Good OSS hygiene.

## Revisit when
- The maintainer's support cadence falls below 30 days for security or compatibility issues.
- A clearly superior alternative emerges (WotC ships official Foundry-equivalent automation, etc.).
- We need commands the module won't accept upstream.
