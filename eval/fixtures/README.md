# Eval Fixtures

Scenario fixtures used by the eval harness. Each `*.eval.yaml` file describes one scenario plus a set of expectations the AI DM's response must satisfy.

See [`docs/design/0004-eval-harness.md`](../../docs/design/0004-eval-harness.md) for the file format and supported expectation kinds.

## What these fixtures do (and don't) cover

The model is **faked**: `llm_script` scripts the narration + tool calls the fake
LLM emits, so these are **deterministic, CI-safe** tests. They are *not* a test
of the model's judgment or the behavior spec — a scripted `tool_called` only
proves the model *was told* to call it.

What they *do* verify, beyond the script echoing back:

- The harness wiring + expectation engine (`contains`, `tool_called`, …).
- **Real tool dispatch.** The emitted tool calls run through the actual
  `createDefaultRegistry()` dispatcher, so `tool_called` is satisfied only when
  the tool is genuinely dispatchable — a call to a **renamed/removed** tool, an
  **operator-gated** tool without the flag, or one with **invalid input** fails
  the expectation. This is what catches drift between fixtures and the tool set.

What validates **model + behavior-spec quality** is live playtest plus
`pnpm eval:live`, which runs these same fixtures against the **real** Anthropic
model with the **real** behavior spec + tools (`ANTHROPIC_API_KEY=… pnpm
eval:live`; out of CI, nondeterministic, skips cleanly without a key). Don't read
a green *scripted* run as "the DM behaves correctly" — only as "the
orchestration contract still holds"; use `eval:live` for behavior.

## Adding a fixture

1. Pick a clear, hyphenated name: `<area>-<scenario>` (e.g., `combat-morale-flee-at-25pct-hp`).
2. Reference the behavior-spec section the fixture exercises in the `description`.
3. Keep player utterances generic. **Do not use real player names, real Discord IDs, or anything personally identifying** — fixtures are public.
4. Run `pnpm eval` locally to confirm the fixture parses and runs.

## Don't

- Don't make fixtures that depend on private campaign content (Phandelver, etc.).
- Don't write fixtures that exercise hard safety limits with explicit content; describe the test via abstract triggers instead.
