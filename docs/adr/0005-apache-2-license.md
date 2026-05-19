# ADR-0005: Apache License 2.0

## Status
Proposed (2026-05-17)

## Context

The project is intended as open source from inception. License choice shapes downstream adoption, contributor experience, and legal exposure. The realistic options for a project of this kind:

- **MIT** — minimal, permissive, widely understood.
- **Apache 2.0** — permissive plus explicit patent grant and contribution clarification.
- **GPL v3 / AGPL v3** — copyleft. Strong viral guarantee; significantly narrows the adoption pool, especially for businesses.
- **MPL 2.0** — file-level copyleft; pragmatic but uncommon for this domain.

This is an LLM-adjacent project. The space has active patent activity, and the user-facing API surface (tool calls, plugin interfaces) is exactly the kind of structure that becomes a patent risk surface if a contributor or downstream user later asserts patents. A permissive license without a patent grant is meaningfully weaker than one with.

## Decision

**The project is released under the Apache License 2.0.**

## Consequences

**Positive**
- **Explicit patent grant.** Contributors grant a patent license to everyone receiving the work. This is the most important property for an LLM-tooling project in 2026.
- **Permissive enough to allow commercial use, forks, and proprietary integrations** without the friction GPL introduces. This matches the project's goal of broad adoption — including by people who want to bolt on commercial campaign marketplaces or hosted services.
- **Compatible with the broad set of plugins** we expect contributors to write (most permissive and weak-copyleft licenses combine fine).
- **NOTICE file handling and attribution requirements** are well-understood and tooling-supported.

**Negative**
- **No copyleft guarantee.** A company could fork Skeinkeeper, build a closed competitor, and contribute nothing back. This is a real trade-off vs. GPL. The judgment here is that adoption breadth matters more for this project than enforced contribution.
- **Slightly more text to comply with** than MIT (NOTICE file, attribution on derivative works). Not a real cost.

**Neutral**
- **Compatibility:** Apache 2.0 is one-way compatible with GPLv3 (Apache code can be incorporated into GPLv3 projects, not vice-versa). For dependency selection, we should avoid GPL dependencies that would force us to relicense.
- **CLA vs. DCO.** Apache 2.0 ships with an inbound license that's strong enough by default that a formal CLA is not strictly necessary; a DCO ("Signed-off-by" in commits) is sufficient. Decision deferred to a separate contribution-flow ADR.

## What about the rules content?
- The **code** is Apache 2.0.
- **D&D 5e SRD content** we ship (rules, basic monster stat blocks) is governed by its own license (CC-BY-4.0 for SRD 5.1; check the 5.2 SRD terms before shipping it). This must be carried in a separate license file.
- **Commercial WotC content** (Phandelver) is operator-supplied per [ADR-0007](./0007-phandelver-content-operator-supplied.md) — never in the repo.

## Revisit when
- A major contributor or sponsor requires a different license as a condition.
- A defensive licensing strategy becomes necessary (e.g., the project becomes large enough that a competitive fork is a real threat — at which point a license change is a community conversation, not a unilateral one).
