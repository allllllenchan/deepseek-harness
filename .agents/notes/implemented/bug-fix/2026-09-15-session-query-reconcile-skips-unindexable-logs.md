# Agent Note: session-query reconcile skips unindexable logs and commits one reconcile at startup

Status: implemented

English | [中文](2026-09-15-session-query-reconcile-skips-unindexable-logs.zh.md)

## Problem

A session log that fails validation on read aborted the whole SQLite index reconcile. A torn write after a hard kill surfaces as `seq gap in committed region` on cold read; the error rethrew out of `_observeStable`'s per-session loop, reconcile committed nothing, and because `_serialized` chains every operation behind one queue, every later search re-ran the identical reconcile and failed with `SESSION_QUERY_INDEX_FAILED`. Repairing the log was the only way to restore search, and the index could not say which log was at fault.

On `openAt: 'startup'` deployments the same reconcile raced a search deadline instead: opening the database handle committed nothing, so the first full corpus observation ran inside the first search's `searchTimeoutMs` and a corpus larger than that deadline aborted, committed nothing, and retried on every later search.

## Decision

Two scoped changes in `SqliteSessionQueryEngine`:

- **An unindexable log is skipped for one observation attempt.** The cold read, header-compatibility check, and observation of one persisted session are wrapped; a non-abort failure logs `skipping unindexable session log <id>: <reason>` and leaves that session out of the index for the attempt. Aborts still propagate, so cancellation keeps its no-index-writes property. Skipping is per attempt: a repaired log (new persistence revision) is re-read and indexed on a later reconcile with no additional state.
- **`openAt: 'startup'` commits one full reconcile after the handle opens.** A failure is logged, not fatal; each search still reconciles as before, so startup reconcile is an eager fast path, not a new failure point.

Visibility: a skipped session stays out of full-text results, while `listSessions` — served from persistence headers, not the index — still lists it, so the corrupt log remains discoverable and deletable at the header level.

## Alternatives considered

**Quarantine the failing id durably** (a table suppressing future reads). Rejected: sticky state needs its own invalidation contract (repair tooling, revision-change rules), while per-attempt skipping already converges — a repaired log re-enters the index on the next reconcile with zero extra state.

**Fail one search instead of the whole reconcile** (catch around `_reconcile` in `searchSessions`). Rejected: a partially updated generation would be reported as a successful result, and queued searches behind `_serialized` would still repeat the failing reconcile.

**Treat a startup reconcile failure as fatal.** Rejected: boot must not depend on corpus health; the search-time reconcile remains the fallback.

## Consequences

Corpus indexing and search availability no longer depend on the health of every log; one damaged log costs only its own search absence. Failed log reads surface as one console line per attempt instead of typed failures, so operators watching only structured errors no longer see reconcile aborts that previously named no culprit. Startup with `openAt: startup` performs the full corpus read that previously happened on first search, moving that cost to activation; deployments that prefer the old timing keep `first-search`. Tests pin the corrupt-session skip, repair recovery, startup warm-up before first search, and startup retry when persistence mounts late.

## Verification

- `tests/sqlite.spec.ts`: a sticky per-session read fault leaves the corrupt session unindexed and absent from full-text results while the healthy corpus stays searchable; clearing the fault and bumping the revision re-indexes it on the next reconcile.
- `tests/sqlite.spec.ts`: with persistence attached after an `openAt: 'startup'` engine mount, the first search still indexes the persisted corpus.
