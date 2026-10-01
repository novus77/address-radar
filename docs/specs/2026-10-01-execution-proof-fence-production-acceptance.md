# Execution Proof Fence: Production Acceptance

## Release and scope

Release: `4ce4d47-execution-proof-fence`.
Observed at: 2026-10-01T14:34:36.246215+00:00.

This slice adds consumer proof revision fencing. It does not claim complete audited
execution revision propagation or completion of the full data lifecycle plan.

## Validation and deployment

Twelve targeted tests, 849 unit tests across 207 files, type checking, build, package
smoke tests, repository boundary checks, and two desktop/mobile browser tests passed.
Commit `4ce4d47` was deployed with the existing guarded deployment workflow. The
payload change required no additional database columns or bulk production rewrite.

A read-only check of the built production domain function confirmed that a proof
from execution revision one cannot certify a demand for revision two, while a
same-revision proof can certify it. No business database was modified for this check.

## Read-only production observations

- All six services were active with `NRestarts=0`.
- Every service process retained `ADDRESS_RADAR_GATEWAY_DELIVERY_ENABLED=false`.
- Available disk: 4608348160 bytes.
- Five-minute inspected SQLite busy/locked, file-lock timeout, contention, schema
  error, invalid budget reservation, and fatal message counts were zero.
- Current 30-day opportunity strategy evaluations covered 671 distinct
  traders. The independent SQL count matched the closed-loop API.
- The versioned historical dispatcher cursor continued to advance after this release
  restart. Its strategy was `trader-ability-v4-opportunity`, not the legacy exhausted
  cursor.
- Current-strategy ability worker jobs: 3,202 completed and 1,021 pending. Job
  completions are not distinct-trader counts.
- Candidate evidence facts remained 1439; candidate evidence blocked
  tasks in the API were 2,126. This observation does not prove new candidate discovery.
- Recovery closure: 2,232 satisfied, 12,982 pending, 532 terminal.
- Signal readiness reported eight produced facts, unchanged in the inspected
  sequence. No signal delivery was enabled.

Distinct current-version evaluations increased from 605 at 14:26 UTC to 627 at
14:29 UTC and 671 at this observation. This demonstrates resumed historical
evaluation progress, not full coverage or queue convergence. The runnable queue
was 1,051 with a positive 15-minute delta; bounded refill and other producers mean
the dispatcher high-water target is not a hard global worker-count cap.

## Remaining acceptance gates

Producers must still derive execution revisions from immutable, audited real
transaction records and propagate them into both demands and proofs. Until then,
existing unversioned payloads retain legacy revision-zero behavior; this release
does not silently mark them as verified real execution data.

Atomic derived-event updates, durable per-consumer revision dispatch and
acknowledgements, source-conflict review, bounded historical repair, strict market
coverage, candidate entry-price provenance, identity-to-wallet handoff, and genuine
new signal production remain open. No automatic identity merge, scoring threshold
change, old-evidence deletion, or bulk historical mutation occurred in this slice.

Capacity cleanup restored deployment headroom but is not a replacement for durable
storage retention/expansion planning. The short observation window is insufficient
for a reliable completion-time estimate.
