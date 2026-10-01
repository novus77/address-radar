# Fomo Request Coordination Contention Isolation SPAC

## Verified production failure

At 2026-10-01 15:43 Asia/Shanghai, the historical-backfill service exited with `FileLockTimeoutError` while acquiring the token request journal's SQLite coordination lock. Systemd restarted it once. This was a coordination timeout, not a demonstrated lock on the primary business database.

The service loop recognized SQLite numeric BUSY/LOCKED error codes but not `FILE_LOCK_TIMEOUT`. Verification ran before historical scheduling; an acquisition failure could prevent unrelated scheduling work. The request journal was approximately 47 MB and the producer built an in-memory Set of every historical lookup ID while holding the coordination lock for each enqueue.

## Changes

- Recognize only typed request lock timeouts and existing numeric SQLite contention codes as retryable.
- Preserve fatal schema, I/O, corruption and compound cleanup failures; do not classify arbitrary messages as transient.
- Isolate retryable contention at verification and scheduler stage boundaries. Continue the other stage unless shutdown or a fatal failure requires stopping.
- Carry partial-cycle contention to the service loop. Even if another stage produces work, apply bounded exponential backoff rather than immediate retry spinning.
- Retain existing lock ownership, request idempotency, append/fsync ordering, cursor and retry semantics. Do not remove or steal coordination locks.
- Replace producer whole-file text/Set construction with a 64 KiB chunk scan using UTF-8 decoding across chunk boundaries. Stop when the matching ID is found.
- Preserve cross-process deduplication inside the same exclusive lock and release all read handles.
- Leave failed enqueue requests retryable; do not mark them queued in business state before durable append succeeds.

## Boundaries

Chunk scanning bounds normal multi-line memory use, but scanning a new request is still O(journal size). It is not an indexed request store, compaction policy, or proof that all contention is eliminated. Consumer/result journal processing and durable indexed handoff remain Task 6 work. Do not delete business request history as a performance shortcut.

No strategy threshold, wallet identity rule or signal delivery configuration changes.

## Tests and deployment

Tests reproduce typed timeouts, partial-cycle fairness, abort handling, fatal aggregate cleanup, partial-cycle backoff, actual coordination contention, producer retry after release, cross-process deduplication and split UTF-8/long lines.

Run targeted/full tests, build, type checks, import smoke, module boundary and browser tests before commit/deployment. Deployment must retain the 3 GB disk guard, prior release rollback and disabled delivery. No new schema migration or business data repair is required.

Read-only production acceptance must distinguish retry warnings from service exits and distinguish journal locks from business SQLite locks. A short healthy observation is not proof that contention never recurs.
