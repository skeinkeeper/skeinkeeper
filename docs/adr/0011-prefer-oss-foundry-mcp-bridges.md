# ADR-0011: Prefer Fully-OSS Foundry MCP Bridges

## Status
superseded by [0029](./0029-first-party-foundry-addon.md) (2026-08-15). **Supersedes [ADR-0001](./0001-use-foundry-mcp-for-vtt.md)** insofar as ADR-0001 endorsed the Patreon-gated `alexivenkov` bridge. The "use a Foundry MCP bridge rather than build our own" portion of ADR-0001 is retained in this historical record only.

## Context

ADR-0001 (2026-05-17) recommended the `alexivenkov/foundry-api-bridge-module` Foundry MCP bridge. That recommendation was based on the bridge being functionally capable and broadly compatible. ADR-0001 acknowledged in a "Negative" note that the bridge requires a Patreon-issued API key, framed as a "soft licensing question."

Two follow-up observations forced a revisit:

1. **The Patreon requirement is not soft.** Skeinkeeper's framing is self-hosted, open-source, no commercial gates. A required Patreon subscription on a runtime dependency contradicts that framing in a way operators reasonably object to. We discovered this when looking more carefully at the bridge's deployment model: its server-side component is closed-source and hosted by the maintainer at `foundry-mcp.com`, gated behind a paid Patreon tier. Only the Foundry-side client module is MIT-licensed.

2. **Fully-OSS alternatives exist.** A wider survey identified two MIT-licensed, fully-self-hostable Foundry MCP bridges that were not on the radar when ADR-0001 was written:

| Project | License | Hosting | API key? | Feature surface |
|---|---|---|---|---|
| [adambdooley/foundry-vtt-mcp](https://github.com/adambdooley/foundry-vtt-mcp) | MIT | Self-hosted (Foundry module + Node MCP server + optional ComfyUI) | None | Actor management, scenes, tokens, compendium search, content creation, campaign tracking |
| [laurigates/foundryvtt-mcp](https://github.com/laurigates/foundryvtt-mcp) | MIT | Self-hosted (single Node server via `bunx`) | None | Actor/NPC queries, dice, scene/combat, journal/notes, items, chat history |
| [alexivenkov/foundry-api-bridge-module](https://github.com/alexivenkov/foundry-api-bridge-module) | MIT (client only); server Patreon-gated | Maintainer-hosted at `foundry-mcp.com` | **Yes — Patreon subscription** | ~71 commands |

Both OSS alternatives cover the surface area Skeinkeeper actually needs, and both are actively maintained.

This ADR also formalizes a project-wide stance that comes out of the [global hard rule #10](../../CLAUDE.md) added the same week: **evaluate alternatives before committing to a third-party dependency, and prefer fully-OSS, self-hostable options.** Patreon-gated, subscription-gated, or single-vendor-hosted dependencies require a written justification — they are not silent defaults.

## Decision

1. The **Skeinkeeper Foundry MCP integration is implemented against [`adambdooley/foundry-vtt-mcp`](https://github.com/adambdooley/foundry-vtt-mcp)** as the recommended default. Reasons:
   - Fully self-hosted; no external service dependency.
   - MIT-licensed end to end (Foundry-side module + Node-side server).
   - Broadest feature surface of the OSS options (actor management, content creation, campaign tracking).
   - Actively maintained.

2. **[`laurigates/foundryvtt-mcp`](https://github.com/laurigates/foundryvtt-mcp) is supported as a simpler alternative.** Operators who prefer a single standalone server with a narrower surface may use it instead. The `FoundryClient` interface (see [TDD 0007](../tdd/0007-foundry-as-source-of-truth.md)) abstracts over both; only the adapter package changes.

3. **The `alexivenkov` bridge is ruled out for the recommended path.** Its MIT-licensed client code is fine to reference, but the integration as shipped requires a Patreon subscription — incompatible with Skeinkeeper's OSS-first, no-commercial-gates stance.

4. **Fork-as-Plan-B is explicit.** Both recommended bridges are MIT. If an upstream maintainer goes inactive, refuses a Skeinkeeper-relevant PR, or makes a breaking change we can't absorb, we fork to `github.com/skeinkeeper/foundry-mcp-bridge` and own it. The bridges are not large codebases; the fork cost is bounded.

## Consequences

**Positive**
- The full dependency chain is OSS. Operators can stand up Skeinkeeper end-to-end without any paid third-party service.
- Two bridges instead of one reduces single-maintainer risk; if one stalls, we have a documented migration path.
- Documenting the OSS-first stance as a project-wide rule (CLAUDE.md hard rule #10) prevents the same mistake from recurring with future dependencies.

**Negative**
- We support two bridge implementations behind the same interface — the adapter package now has more surface to test.
- The original ADR-0001 survey was incomplete; we built on a default that had to be reversed. Process implication captured in CONTRIBUTING.md: evaluate fully-OSS alternatives at the ADR stage, not after.

**Neutral**
- The `FoundryClient` interface from TDD 0007 was the abstraction that made this swap cheap. Without it, swapping bridges would have rippled into the orchestrator. Confirms the value of that interface.

## Revisit when
- A clearly superior fully-OSS bridge emerges.
- Foundry itself ships an official MCP surface (at which point we evaluate switching).
- One of the recommended bridges' support cadence falls below 30 days for security or compatibility issues — that's the trigger for the fork or for promoting the alternative to default.
