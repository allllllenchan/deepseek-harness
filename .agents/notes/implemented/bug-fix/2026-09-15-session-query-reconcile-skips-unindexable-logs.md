# Agent Note: session-query reconcile skips unindexable logs and commits one reconcile at startup

Status: implemented

English | [中文](2026-09-15-session-query-reconcile-skips-unindexable-logs.zh.md)

## Problem

A session log that fails validation on read aborted the whole SQLite index reconcile. A torn write after a hard kill surfaces as `seq gap in committed region` on cold read; the error rethrew out of `_observeStable`'s per-session loop, reconcile committed nothing, and because `_serialized` chains every operation behind one queue, every later search re-ran the identical reconcile and failed with `SESSION_QUERY_INDEX_FAILED`. Repairing the log was the only way to restore search, and the index could not say which log was at fault.

On `openAt: 'startup'` deployments the same reconcile raced a search deadline instead: opening the database handle committed nothing, so the first full corpus observation ran inside the first search's `searchTimeoutMs` and a corpus larger than that deadline aborted, committed nothing, and retried on every later search.

## Decision

Two scoped changes in `SqliteSessionQueryEngine`:

- **An unindexable log is skipped per revision.** The cold read, header-compatibility check, and observation of one persisted session are wrapped; a non-abort failure records `(sessionId, revision, reason)` in the engine's in-process unindexable map and leaves that session out of the index. Aborts still propagate, so cancellation keeps its no-index-writes property. Later reconciles skip the read while the artifact keeps that revision — unchanged bytes cannot produce a different verdict, and a corpus with unreadable history would otherwise repay the failed reads on every search. A repaired or appended log carries a new revision, is read again, and clears its entry.
- **`openAt: 'startup'` queues one full reconcile on the serialized tail.** Activation opens the handle, which is the readiness boundary, and queues the corpus backfill behind `_serialized` instead of awaiting it: process boot no longer waits for a full corpus read, while a search arriving mid-backfill queues behind the reconcile rather than indexing inside its own deadline. A reconcile failure is logged, not fatal; each search still reconciles as before, so the startup pass is an eager fast path, not a new failure point.

Skipped logs are reported as **one warning line per reconciliation pass** that attempts them (count, up to three ids, the first reason), so a corpus holding hundreds of unreadable logs costs one line at boot and silence afterwards.

Visibility: a skipped session stays out of full-text results, while `listSessions` — served from persistence headers, not the index — still lists it, so the corrupt log remains discoverable and deletable at the header level.

## Alternatives considered

**Quarantine the failing id durably** (a table suppressing future reads). Rejected: durable state needs its own invalidation contract (repair tooling, revision-change rules, schema migration), while an in-process per-revision memo already removes the repeated cost within a process and converges across restarts — a repaired log re-enters the index on the next reconcile. The memo's cost is that a failure caused by unchanged bytes and a transient condition is not retried until the next process.

**Fail one search instead of the whole reconcile** (catch around `_reconcile` in `searchSessions`). Rejected: a partially updated generation would be reported as a successful result, and queued searches behind `_serialized` would still repeat the failing reconcile.

**Treat a startup reconcile failure as fatal.** Rejected: boot must not depend on corpus health; the search-time reconcile remains the fallback.

## Consequences

Corpus indexing and search availability no longer depend on the health of every log; one damaged log costs only its own search absence plus one line in the pass that first attempts it. Failed log reads surface as one aggregated warning instead of typed failures, so operators watching only structured errors no longer see reconcile aborts that previously named no culprit. With `openAt: startup` the full corpus read moves to a queued backfill at activation: boot proceeds immediately, the index is committed before the first search that queues behind it, and deployments that prefer the old timing keep `first-search`. Tests pin the corrupt-session skip, the no-re-read rule for a refused revision, repair recovery, startup warm-up before first search, and startup retry when persistence mounts late.

## Verification

- `tests/sqlite.spec.ts`: a sticky per-session read fault leaves the corrupt session unindexed and absent from full-text results while the healthy corpus stays searchable; the refused revision is read once and not again on a later search; clearing the fault and bumping the revision re-indexes it on the next reconcile.
- `tests/sqlite.spec.ts`: with persistence attached after an `openAt: 'startup'` engine mount, the first search still indexes the persisted corpus; with persistence attached before the mount, the same search reuses the committed rows and the log is read exactly once.
