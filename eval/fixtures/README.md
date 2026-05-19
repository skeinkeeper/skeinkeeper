# Eval Fixtures

Scenario fixtures used by the eval harness. Each `*.eval.yaml` file describes one scenario plus a set of expectations the AI DM's response must satisfy.

See [`docs/design/0004-eval-harness.md`](../../docs/design/0004-eval-harness.md) for the file format and supported expectation kinds.

## Adding a fixture

1. Pick a clear, hyphenated name: `<area>-<scenario>` (e.g., `combat-morale-flee-at-25pct-hp`).
2. Reference the behavior-spec section the fixture exercises in the `description`.
3. Keep player utterances generic. **Do not use real player names, real Discord IDs, or anything personally identifying** — fixtures are public.
4. Run `pnpm eval` locally to confirm the fixture parses and runs.

## Don't

- Don't make fixtures that depend on private campaign content (Phandelver, etc.).
- Don't write fixtures that exercise hard safety limits with explicit content; describe the test via abstract triggers instead.
