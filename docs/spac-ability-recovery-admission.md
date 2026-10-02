# SPAC: Ability Recovery Admission and Verified Progress

## Scope and unchanged rules

Preserve opportunity-based ability evaluation, the 30-day window, candidate admission thresholds, identity ownership and disabled Gateway delivery. Missing facts are deferred work, not negative evidence or completed consumers.

## Confirmed faults

1. Consumer-history wakeups bypass the ability queue high-water mark. They can keep admitting work after other producers stop at capacity.
2. Their handwritten active-state query omits `retryable`. The enqueue helper refuses a duplicate, but the caller still records the new history fingerprint as dispatched. The obligation may then disappear without a new evaluation.
3. The daily ability scan competes with fact-triggered re-evaluation for the same 1,000-job admission capacity. The regression reproduces daily dispatch occupying the recovery headroom.

## Implementation

Use the job store's canonical subject-active check, not a second status list. Check active capacity inside the same write transaction before enqueueing. At capacity or with an active owner, keep the new observed fingerprint but do not acknowledge dispatch. Existing bounded consumer rotation remains unchanged. Use the shared queue policy high-water mark rather than another numeric threshold.

Daily scanning now stops at 900 active worker jobs, reserving 100 of the existing 1,000-job budget for corrections and recovered history. The reservation does not increase total capacity or admission thresholds. Candidate-triggered production must also be assessed before claiming all producers share backpressure.

## Tests and release gates

Reproduce queue admission above 1,000 and incorrect dispatch acknowledgement with a retryable owner. Verify that freeing one slot admits one consumer, the other remains deferred, and replay does not duplicate work. Verify daily dispatch stops at 900 and resumes after freeing a worker slot. Run targeted tests, full tests, type checks, builds, import smoke checks, boundary checks and browser tests before commit and production deployment. Retain a verified production backup and previous release.

## Production acceptance

Measure source-fact ability obligations pending/dispatched, actual completed evaluations, distinct covered traders and active queue size independently. A dispatch is not an execution receipt. Do not cancel pending obligations or acknowledge old signal requests to make counters look healthy.

## Remaining closure gaps

Historical milestone gaps and unresolved identities remain independent prerequisites. Signal and aggregation revision receipts still need real production evidence. Most old signal revision requests lie outside the existing live window; handling them requires an explicit historical disposition, not a fabricated consumption acknowledgement. A healthy service or passing tests does not establish complete business closure.
