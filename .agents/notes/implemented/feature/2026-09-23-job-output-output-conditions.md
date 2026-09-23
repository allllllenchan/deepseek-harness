# Agent Note: job_output waits on output conditions and bounds its own reads

Status: implemented

English | [中文](2026-09-23-job-output-output-conditions.zh.md)

## Problem

`job_output(wait: true)` could end only at a job's settlement or at its deadline. A job that prints the line the model is waiting for and then keeps running therefore had no wait that ended when the interesting line arrived. The observed workaround for a multi-hour cook was a loop of `Start-Sleep -Seconds 420` followed by a fresh read: it spends a model step per iteration, spends it on a stamp of logs the caller did not ask for, and — because each read consumes its delta — ingests segments the caller cannot get back. The tool's own prompt told the model not to poll or sleep, and had nothing better to offer.

The same read had no caller-side bound. `tail_lines` and `max_bytes` did not exist, so "show me the end of that segment" was expressed by taking the whole segment and letting a later truncation decide.

Two of the three shipped background producers register jobs without `outputLimitBytes` as well: `tool-terminal` declares `maxResultBytes`, while `tool-bash` and `tool-pwsh` declared nothing. Their executor's in-memory output window bounds what the process keeps, not what a model-facing read or completion notice may return: a lossy read returns the whole retained window, a deployment can raise that window, and the completion notice that carries the model-authored command had no bound at all.

## Decision

`job_output` accepts three optional parameters. `pattern` (with `wait: true`) ends the wait at the first read whose output contains that literal text, and the call returns the output read up to that point, including the match. `tail_lines` returns only the trailing N lines. `max_bytes` caps the complete model-facing result.

### The wait stays the job's single output consumer

A pattern wait reads incrementally: it reads the delta since the previous read, appends it to a bounded `TextRetainer`, tests the pattern against the output read so far (carrying the previous read's last `pattern.length - 1` characters, so a match split across two deltas is still found), and otherwise waits one `patternPollIntervalMs` tick through `ctx.jobs.wait`. It ends at a match, at a terminal status, at the deadline, or on caller cancellation; all four return the output read so far plus the live job snapshot, and none is an error.

This keeps the capability seam's one-cursor rule intact: the wait loop is still one `job_output` call reading the job, exactly as a single read after a wait was. What changed is only whether the consumer reads once or repeatedly. Two concurrent `job_output` calls on one stream job still race for deltas, which they already did.

The caller's output is delivered rather than dropped. Everything the wait reads is retained and returned, so the output consumed on the way to a match reaches the model; the alternative would consume bytes the wait is the only reader of and make them unrecoverable. What can still drop content is a declared budget, and each such budget states its omission at the head of the returned text: `[earlier output omitted: N lines]` for `tail_lines`, `[earlier output omitted: N bytes]` for the retention ceiling a wait applies when neither the caller nor the producer declared a byte budget.

### One byte bound, tightened by the caller

`max_bytes` resolves into the existing producer bound rather than introducing a second truncation: the prepended `tools/pre-execute` listener already reads the caller-visible job's `outputLimitBytes`, and it now returns `min(producerLimit, max_bytes)` for `job_output`. `finalizeContent` then bounds the complete rendered result through the machinery that already reserves the `[status: ...]` suffix and reuses an existing truncation marker, so errors, policy replacements, and pipeline failures are bounded the same way. The result value keeps its `{ text, job }` contract.

`pattern` without `wait: true` is rejected rather than silently inert, as are a non-string or empty pattern and non-positive budgets.

### Poll cadence and retention are configured, not implied

`patternPollIntervalMs` (default 250 ms) is a `Config` field: it trades detection latency against read frequency, which deployments differ on. The retention ceiling for a wait that has no byte budget to spend is a fixed `MAX_WAIT_RETENTION_BYTES` (1 MiB) — a memory-safety bound, not a policy knob, because the caller already owns that axis through `max_bytes`; it reports what it dropped.

`tool-bash` and `tool-pwsh` gain `maxResultBytes` (default 256 KiB, mirroring `tool-terminal`'s `DEFAULT_MAX_RESULT_BYTES`) and pass it as the job's `outputLimitBytes`. The default deliberately sits above the executor's default 64 KiB-per-stream window so a normal lossy read of stdout and stderr is not truncated twice; the cap exists for a raised window, for the completion notice, and for parity with the third producer.

## Alternatives considered

- **A non-consuming output preview on the producer contract.** `JobHooks.previewOutput()` would let a wait test output without consuming it, but it changes the contract every producer implements and every job kind inherits, to avoid a retention buffer the consumer can own itself.
- **Buffer non-matching deltas in a per-job table inside `tool-jobs`.** It satisfies "a later `job_output` can still read them" without a retainer, but it moves the cursor's state out of the job, has no natural lifetime (owner disposal, teardown, id reuse), and is unbounded for exactly the callers who asked for no bound.
- **Return only the matched region.** The cheapest result for the motivating case, and the one that loses the most: the wait is the only reader, so the rest of the segment is gone, and a caller that wanted surrounding context cannot ask for it.
- **A regex `pattern`.** A literal substring keeps the model-facing contract free of dialect questions, of invalid-pattern failures the caller must handle, and of catastrophic-backtracking exposure.
- **An output-progress event on `ctx.jobs`.** Producers would all have to publish byte progress, and the registry's change feed describes the visible job set, not bytes; polling one job's cursor is owned entirely by this consumer.
- **Making `pattern` imply `wait: true`, or ignoring it without `wait`.** Implicit blocking hides a scheduling decision, and a silently inert argument hides the caller's mistake; the rejection names the fix.
- **Bounding the wait's retention inside `ctx.jobs.wait`.** Bounds belong where the complete result is known, which is the tool that renders it; the registry has no model-facing result to bound.

## Consequences

A model that would have slept for seven minutes now blocks on the one line it needs and receives the output on the way to it. A blocked wait no longer needs a `timeout_ms` guess to be useful, and a caller that gets an answer can still act on a job that is running.

What it costs: a pattern wait reads on every poll tick for as long as it waits, so a job producing nothing costs one read and one `ctx.jobs.wait` waiter per tick; a match is noticed up to one tick after the bytes arrive (recorded as a package limitation, since the registry exposes no per-output notification); and the wait holds up to the caller's byte budget — or 1 MiB without one — in memory while it runs.

Verification: `packages/jobs/tool-jobs/tests/tool-jobs.spec.ts` pins the early return, the match split across two reads, the timeout against a live job, settlement without a match, the loss-free delivery of the deltas read before the match (including that the cursor advanced past them), `tail_lines` and its omission markers, `max_bytes` tightening — never widening — the producer cap, the composition of all three parameters, the retention ceiling, every rejected argument, and the load-time cadence guard. `packages/shell/tool-pwsh/tests/tools.spec.ts` pins the declared producer cap, its truncating effect on a read, and the bare-config guard; `packages/shell/tool-bash/tests/tools.spec.ts` pins the same cap and guard through its real job runtime.
