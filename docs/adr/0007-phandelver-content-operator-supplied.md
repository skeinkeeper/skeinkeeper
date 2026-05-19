# ADR-0007: Commercial Campaign Content Stays Operator-Supplied

## Status
Accepted (2026-05-17)

## Context

The project's first reference campaign is *Lost Mine of Phandelver*, a commercial D&D 5e module published by Wizards of the Coast. WotC's content is copyrighted; redistribution is not permitted, even in service of a free tool.

The project's broader goal is to support many campaigns. Most quality published campaigns are commercial (WotC, Paizo, indie publishers like Free League, etc.). The project must have a coherent policy on commercial content from day one — because the first contributor to ship "Curse of Strahd support" will, naively, try to put the module text in a PR.

The line we need is clear: the project ships **abstractions, loaders, and chunkers**. The operator provides **content** from their own legally-acquired copy.

## Decision

**Commercial campaign content is never committed to the repository.** Operators load content into their own deployment from their own legally-acquired copies via the web UI.

What the repo ships for any given commercial campaign:
- **Loader logic** — code to parse and structure the campaign's content into our schema.
- **Chunking strategy** — how the content should be split for cold-knowledge retrieval (by location, by encounter, by NPC, etc.).
- **Behavior spec overlays** — campaign-specific guidance for the AI ("Phandelver is a beginner module; default to gentle pacing; the BBEG is named X and motivated by Y").
- **Asset templates** — empty scene templates, suggested map dimensions, encounter table scaffolds. No commercial art, text, or stat blocks.

What the operator provides:
- The actual PDF, EPUB, or text of the campaign.
- Any maps, art, or assets they legally own.
- Optionally, OCR'd or transcribed text for content they own in physical form.

For **SRD-licensed content** (D&D 5.1 SRD under CC-BY-4.0, or the eventual 5.2 SRD), shipping in the repo *is* permitted. SRD rules, basic monsters, and core mechanics may be included with proper attribution.

## Consequences

**Positive**
- **No copyright infringement.** The project can run on commercial campaigns without taking on legal exposure.
- **Contributors have a clear rule.** PRs that include commercial content are rejected with a standard message pointing to this ADR.
- **The abstraction is honest.** "Bring your own content" mirrors how most tabletop tools (Foundry modules, Roll20 marketplace) handle this.
- **Operator-supplied content keeps the project on the right side of WotC's IP enforcement** while still enabling rich gameplay with commercial campaigns the operator legally owns.

**Negative**
- **Higher friction for new users.** A user can't `git clone && play Phandelver`; they must own Phandelver and load it into their deployment.
- **The loader/chunker code can't be fully tested against real content in CI.** We need a synthetic test fixture (e.g., a public-domain mock campaign) for CI; real validation happens manually against an operator's content.
- **We can't sanity-check that the chunking strategy is good** without a campaign loaded — making the design feedback loop slower.

**Neutral**
- A "synthetic Phandelver-like" public-domain campaign for CI is worth building or sourcing. A small adventure derived from SRD content would suffice.
- The web UI's content upload flow becomes a first-class feature: drag-and-drop a PDF, watch it chunk and embed. The quality of this flow heavily influences how usable the platform is.
- WotC's stance on AI is currently hostile (per recent statements from D&D Beyond leadership). Shipping commercial WotC content in any form would invite the wrong kind of attention. This ADR keeps the project on the right side of that line by default.

## What this means for the README
- Setup instructions must clearly state that the user supplies their own campaign content.
- A "supported campaigns" list documents which campaigns have loader logic + behavior overlays — without including the content itself.
- The first PR that ships commercial content closes immediately with a pointer to this ADR.
