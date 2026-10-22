# Agent Note: Malformed live tool arguments reach the tool instead of failing the turn

Status: implemented

English | [中文](2026-10-22-tolerate-malformed-live-tool-arguments.zh.md)

## Problem

A DeepSeek Messages response whose streamed tool arguments are not valid JSON ended the whole turn with `MALFORMED_RESPONSE`. Session logs show two shapes: an unescaped ASCII quote inside a long Chinese argument string, and the model's own native tool markup appended after an otherwise complete JSON object. Three consecutive turns failed on the same tool call, and `MALFORMED_RESPONSE` is not in the default retryable set.

The adapter was the only production code that parsed tool arguments for validity. Every consumer downstream already tolerates invalid text: the agent loop keeps it as text for the tool's own schema check, and Messages serialization sends `{}` for historical arguments that are malformed or are not objects.

## Decision

[translate.ts](../../../../packages/llm/llm-deepseek/src/translate.ts) no longer parses completed tool arguments. The arguments reach the assembled assistant message byte for byte, and the tool's schema check turns an unusable value into an `INVALID_ARGS` tool result that the model reads and corrects in the same turn.

Protocol validation stays: block order, block indexes, tool identity, stop reasons, and SSE framing still fail with `MALFORMED_RESPONSE`. `max-tokens` truncation still drops tool calls in the shared assembler.

## Alternatives considered

- **Prune the unexecutable call**, as `max-tokens` does. The message then has no tool call, and the agent loop ends the turn as completed, so the model's intended work disappears without a trace.
- **Repair the arguments to `{}`.** That fabricates a call the model never made, and a tool whose parameters are all optional would execute it.
- **Add `MALFORMED_RESPONSE` to the retryable codes.** A retry carries no correction signal, and that code also covers protocol damage a retry cannot repair.
- **A Config switch that defaults to strict.** That is the upstream-acceptable form; this deployment flips the default instead, because activating the switch means editing a live `~/.dsh` profile.

## Consequences

A bad call costs one `INVALID_ARGS` round trip instead of the turn, and one unusable call no longer ends a sibling call in the same response. The failure is no longer visible as a `turn/end` error: the turn completes, and the evidence is the tool result plus the raw arguments in the session log. Those raw arguments stay in the assistant message, the `tool/call` event, and the tool result, so a client may render one long unusable argument blob. Serializing the next request falls back to `{}` for that historical call, as already recorded for foreign history.

This deviates from the upstream contract that newly generated tool arguments must be valid JSON objects, whose test asserted the refusal. Restoring a completable-arguments check before `finish` is the revert.
