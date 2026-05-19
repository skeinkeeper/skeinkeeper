# ADR-0001: Use a Fully-OSS Foundry MCP Bridge for VTT Integration

## Status
Accepted (2026-05-17, revised 2026-05-19)

## Context

The AI DM must operate Foundry VTT autonomously — moving tokens, managing combat, rolling dice, controlling scenes, applying conditions, reading actor state. Implementing this from scratch is a substantial undertaking: Foundry's JavaScript API is large, version-sensitive, and changes meaningfully across major releases (v11 → v12 → v13 → v14).

Three community-maintained Foundry MCP integrations exist as of 2026-05:

| Project | License | Hosting model | API key required? | Feature surface |
|---|---|---|---|---|
| [alexivenkov/foundry-api-bridge-module](https://github.com/alexivenkov/foundry-api-bridge-module) | MIT (client only) | Server side hosted by maintainer at `foundry-mcp.com` | **Yes — Patreon subscription** | ~71 commands; well-covered |
| [adambdooley/foundry-vtt-mcp](https://github.com/adambdooley/foundry-vtt-mcp) | MIT | **Fully self-hosted** (Foundry module + Node MCP server + optional ComfyUI) | None | Actor management, scenes, tokens, compendium search, content creation, campaign tracking |
| [laurigates/foundryvtt-mcp](https://github.com/laurigates/foundryvtt-mcp) | MIT | **Fully self-hosted** (single Node server via `bunx`) | None | Actor/NPC queries, dice, scene/combat, journal/notes, items, chat history |

Building our own equivalent would consume an estimated 4–6 weeks of effort that delivers zero player-facing value beyond what the existing modules provide.

## Decision

For v1, the **`VTTDriver` for Foundry is implemented as a thin adapter over [adambdooley/foundry-vtt-mcp](https://github.com/adambdooley/foundry-vtt-mcp)**, with [laurigates/foundryvtt-mcp](https://github.com/laurigates/foundryvtt-mcp) supported as a lighter alternative.

We choose adambdooley as the recommended default because:
- **Fully self-hosted** — aligns with Skeinkeeper's OSS-first, no-external-service stance per ADR-0010.
- **No API keys, no Patreon, no commercial gates** — operators install a Foundry module + run a local Node MCP server.
- **Broader feature surface** — covers actor management, content creation, campaign tracking, and token manipulation, which lines up with what the AI DM needs to do during a session.
- **Permissive license** — MIT both for the Foundry-side module and the Node-side server.
- **Active maintenance** — 21+ releases, latest as of May 2026.

We explicitly **rule out the alexivenkov bridge** for the recommended path because its server-side component is closed-source and Patreon-gated. The module's MIT-licensed client code is fine to read for reference, but the integration as shipped would require Skeinkeeper operators to maintain a Patreon subscription — a conflict with the project's "self-hosted, open-source, no commercial dependencies" framing.

**Fork-as-Plan-B:** Both recommended bridges are MIT-licensed. If the upstream maintainer goes inactive, refuses a Skeinkeeper-relevant PR, or makes a breaking change we can't absorb, we fork to `github.com/skeinkeeper/foundry-mcp-bridge` and own it. The cost of doing so is bounded (the MCP bridges are not large codebases) and we retain full control of the integration surface.

The adapter normalizes the MCP commands into our internal `FoundryClient` interface (see design doc [0007](../design/0007-foundry-as-source-of-truth.md)), so that future VTT drivers (Roll20, Owlbear Rodeo, native alternative) implement the same shape.

## Consequences

**Positive**
- Foundry integration is largely "done" on day one. Engineering time redirects to the harder problems: orchestration, memory, and behavior.
- Fully OSS dependency chain — no operator pays a third party for the AI-DM integration to work.
- The bridge's contributor community benefits us — bug fixes and Foundry-version-compatibility updates flow in for free.
- The MCP surface is already designed to be AI-consumable; we don't have to invent that abstraction.

**Negative**
- We take on a third-party dependency whose roadmap we don't control. If the maintainer slows down, we inherit the cost of forking or contributing upstream. Mitigation: Plan-B fork documented; bridge codebases are small enough to maintain.
- We're constrained by the commands the bridge exposes. Capabilities outside its surface require either upstreaming a contribution, forking, or implementing direct Foundry calls alongside the bridge.
- Two competing OSS bridges exist; we pick adambdooley as default but operators may use laurigates instead. Mitigation: the `FoundryClient` interface (per design doc 0007) abstracts over both — only the adapter package changes.

**Neutral**
- The `FoundryClient` abstraction means we can later replace the implementation without affecting the orchestrator. The bridge is the **implementation**, not the **interface**.
- We should contribute back to whichever bridge we use (bug reports, command additions). Good OSS hygiene; also reduces fork risk.

## Revisit when
- The chosen bridge's support cadence falls below 30 days for security or compatibility issues.
- A clearly superior alternative emerges (Foundry Gaming LLC ships official AI-DM-grade automation, etc.).
- We need commands the bridge won't accept upstream — that's the fork trigger.
- Foundry itself adopts an official MCP surface, at which point we evaluate switching to it.
