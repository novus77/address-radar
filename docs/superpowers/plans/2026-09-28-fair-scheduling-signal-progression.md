# Fair Scheduling and Signal Progression Implementation Plan

## Phase 1: scheduler correctness

- Scope job-type fairness state by lane.
- Stop inactive lanes from accumulating credit.
- Add runnable workload counting.
- Apply runnable capacity to candidate evidence admission.

## Phase 2: durable signal projection

- Add `signal_projection_requests` and scan state.
- Add a material-fingerprint reconciler.
- Add the `signal_projection` worker and queue policy.
- Register configuration, runtime wiring, package dependency, and exports.

## Phase 3: validation and rollout

- Add scheduler fairness coverage for dormant lanes and cross-lane dispatcher traffic.
- Add projection revision, restart, idempotency, and stale-evidence coverage.
- Run targeted tests, full tests, type checking, and build.
- Back up production, deploy, migrate, and enable the new job type.
- Perform read-only acceptance with 15-minute deltas until queues converge.

Production deployment is a separate explicitly approved step.
