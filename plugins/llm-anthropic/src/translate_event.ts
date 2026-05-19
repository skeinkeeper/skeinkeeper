// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import type { BetaRawMessageStreamEvent } from "@anthropic-ai/sdk/resources/beta/messages";
import type {
  LLMEvent,
  StopReason,
  TokenUsage,
} from "@skeinkeeper/orchestrator";

/**
 * Translate the Anthropic SDK's raw stream events into our provider-neutral
 * LLMEvent stream. Pure async generator; testable with any AsyncIterable
 * of SDK events (real or hand-crafted).
 *
 * Per design doc 0008 § "Streaming-first" and § "Compaction support from
 * day 1."
 */
export async function* translateStreamEvents(
  events: AsyncIterable<BetaRawMessageStreamEvent>,
): AsyncIterable<LLMEvent> {
  const toolBuffers = new Map<number, { id: string; name: string; inputJson: string }>();
  const usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  let stopReason: StopReason = "end_turn";

  for await (const ev of events) {
    switch (ev.type) {
      case "message_start": {
        const u = ev.message.usage;
        usage.inputTokens = u.input_tokens ?? 0;
        if (u.cache_creation_input_tokens != null) {
          usage.cacheCreationInputTokens = u.cache_creation_input_tokens;
        }
        if (u.cache_read_input_tokens != null) {
          usage.cacheReadInputTokens = u.cache_read_input_tokens;
        }
        break;
      }

      case "content_block_start": {
        const block = ev.content_block;
        if (block.type === "tool_use") {
          toolBuffers.set(ev.index, {
            id: block.id,
            name: block.name,
            inputJson: "",
          });
        } else if (block.type === "compaction") {
          yield {
            kind: "compaction",
            block: { type: "compaction", opaque: block },
          };
        }
        // text, thinking, server_tool_use, and result blocks: nothing to do
        // here; deltas carry the content.
        break;
      }

      case "content_block_delta": {
        const d = ev.delta;
        if (d.type === "text_delta") {
          yield { kind: "text_delta", text: d.text };
        } else if (d.type === "thinking_delta") {
          yield { kind: "thinking_delta", text: d.thinking };
        } else if (d.type === "input_json_delta") {
          const buf = toolBuffers.get(ev.index);
          if (buf) buf.inputJson += d.partial_json;
        }
        // signature_delta, citations_delta, and compaction deltas: ignored
        // (they don't carry caller-visible content for our use case).
        break;
      }

      case "content_block_stop": {
        const buf = toolBuffers.get(ev.index);
        if (buf) {
          let input: unknown = {};
          try {
            input = buf.inputJson ? JSON.parse(buf.inputJson) : {};
          } catch {
            // Malformed JSON; surface as empty input and let the dispatcher
            // reject via Zod validation.
          }
          yield { kind: "tool_call", id: buf.id, name: buf.name, input };
          toolBuffers.delete(ev.index);
        }
        break;
      }

      case "message_delta": {
        if (ev.usage.output_tokens != null) usage.outputTokens = ev.usage.output_tokens;
        if (ev.delta.stop_reason) stopReason = mapStopReason(ev.delta.stop_reason);
        break;
      }

      case "message_stop":
        // No useful payload; we emit `done` after the loop.
        break;
    }
  }

  yield { kind: "done", stopReason, usage };
}

function mapStopReason(r: string | null): StopReason {
  switch (r) {
    case "end_turn":
    case "stop_sequence":
      return "end_turn";
    case "tool_use":
      return "tool_use";
    case "max_tokens":
      return "max_tokens";
    case "refusal":
      return "refusal";
    case "pause_turn":
      // Beta compaction triggers a `pause_turn` stop. The caller should
      // round-trip the compaction block on the next request.
      return "compacted";
    default:
      return "end_turn";
  }
}
