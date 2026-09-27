# Scanner Idempotency and Automation Resilience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop scanner conflict storms, make source ingestion semantically idempotent, park and event-wake source-blocked work, and guarantee bounded progress for every enabled automation job type.

**Architecture:** Keep the existing SQLite and systemd deployment. Add a versioned semantic fingerprint and conflict ledger at the source boundary, isolate scanner failures with aggregation and backoff, model missing prerequisites as `blocked_source`, and use weighted job-type fairness inside the existing lane scheduler. Planner high-water marks and disk pressure guards provide backpressure at ingestion and planning boundaries.

**Tech Stack:** TypeScript, Node.js 24, SQLite `DatabaseSync`, Vitest, pnpm workspaces, systemd, rsyslog/journald.

---

## Execution Rules

- Execute tasks in order.
- Start production containment before implementation because current logs can exhaust disk.
- Keep `ADDRESS_RADAR_GATEWAY_DELIVERY_ENABLED=false` for every task and deployment checkpoint.
- Use TDD for every behavior change.
- Do not increase worker concurrency in this plan.
- Do not delete existing observations or automation jobs.
- Create a verified database backup before every production schema or queue migration.
- Stop at any failed acceptance gate and restore the previous immutable release.

## File Map

| Area | Responsibility |
| --- | --- |
| `packages/domain/src/source-observation.ts` | Semantic observation and write-result contracts |
| `packages/domain/src/automation-job.ts` | Durable automation statuses |
| `packages/collectors/src/source-observation-ingestor.ts` | Observation-first ingestion behavior |
| `packages/database/src/source-ledger-store.ts` | Fingerprints, conflict ledger, readiness notifications |
| `packages/database/src/automation-job-store.ts` | Blocked jobs, wakeup, type-aware claiming, snapshots |
| `packages/database/src/migrations.ts` | Additive production migration hooks |
| `apps/scanner/src/runtime.ts` | Duplicate/conflict handling and collector isolation |
| `apps/scanner/src/error-aggregator.ts` | Bounded repeated-error summaries |
| `apps/scanner/src/collector-backoff.ts` | Per-collector exponential backoff |
| `apps/scanner/src/disk-pressure-guard.ts` | Root filesystem ingestion guard |
| `apps/scanner/src/config.ts` | Scanner resilience configuration |
| `apps/automation/src/candidate-readiness.ts` | Candidate prerequisite evaluation and recovery routing |
| `apps/automation/src/candidate-evidence-worker.ts` | Ready-only candidate execution and wakeup |
| `apps/automation/src/job-type-fairness.ts` | Weighted deficit round-robin selector |
| `apps/automation/src/scheduler.ts` | Lane selection plus job-type fairness |
| `apps/automation/src/trader-backfill-planner.ts` | Durable cursor and pending high-water mark |
| `apps/automation/src/token-partition-planner.ts` | Historical partition backpressure |
| `apps/automation/src/config.ts` | Queue limits, weights, and blocked-source timing |
| `apps/automation/src/runtime.ts` | Wiring for readiness, fairness, and migration-safe execution |
| `packages/observability/src/runtime-quality.ts` | Queue, conflict, disk, and log quality metrics |
| `apps/console` | Chinese operator diagnostics and queue visibility |
| `deployment/systemd/address-radar-scanner.service` | Host-level scanner log safety limit |
| `scripts/migrate-automation-resilience.ts` | Bounded production queue reclassification |
| `docs/operations` | Containment, rollout, acceptance, and rollback runbooks |

### Task 0: Contain the Production Log Storm

**Files:**

- Create: `docs/operations/scanner-conflict-incident.md`
- No application code changes

- [ ] **Step 1: Capture bounded incident evidence**

Run:

```bash
ssh ubuntu@152.32.185.240 '
  set -euo pipefail
  stamp=$(date -u +%Y%m%dT%H%M%SZ)
  sudo journalctl -u address-radar-scanner.service -n 5000 --no-pager \
    > /tmp/address-radar-scanner-${stamp}.log
  sudo tail -n 5000 /var/log/syslog \
    > /tmp/address-radar-syslog-${stamp}.log
  sha256sum /tmp/address-radar-*-${stamp}.log
'
```

Expected: two bounded log files and two SHA-256 hashes.

- [ ] **Step 2: Stop only scanner ingestion**

Run:

```bash
ssh ubuntu@152.32.185.240 '
  set -euo pipefail
  sudo systemctl stop address-radar-scanner.service
  test "$(systemctl is-active address-radar-scanner.service)" = inactive
  for service in \
    address-radar-automation.service \
    address-radar-wallet-monitor.service \
    address-radar-wallet-analysis.service \
    address-radar-historical-backfill.service \
    address-radar-console.service
  do
    test "$(systemctl is-active "$service")" = active
  done
'
```

Expected: scanner is inactive; all five non-scanner services remain active.

- [ ] **Step 3: Reclaim runaway log space safely**

Run:

```bash
ssh ubuntu@152.32.185.240 '
  set -euo pipefail
  sudo logrotate -f /etc/logrotate.conf
  sudo journalctl --vacuum-size=1G
  sudo truncate -s 0 /var/log/syslog
  df -h /
'
```

Expected: root filesystem has at least 20% free space. If it does not, stop and inspect backups, imports, releases, database, and WAL before deleting anything.

- [ ] **Step 4: Write the incident runbook**

Document the commands above, preserved evidence paths, service impact, source cursor recovery, and the requirement that scanner remains stopped until Task 4 passes server-side smoke tests.

- [ ] **Step 5: Commit the runbook**

```bash
git add docs/operations/scanner-conflict-incident.md
git commit -m "docs: add scanner conflict containment runbook"
```

### Task 1: Add Versioned Semantic Observation Fingerprints

**Files:**

- Modify: `packages/domain/src/source-observation.ts`
- Modify: `packages/domain/test/source-observation.test.ts`
- Modify: `packages/database/src/source-ledger-store.ts`
- Modify: `packages/database/test/source-ledger-store.test.ts`

- [ ] **Step 1: Write failing domain tests**

Add tests proving collection time is excluded while business fields remain semantic:

```ts
it("keeps the semantic fingerprint stable when only collection time changes", () => {
  const first = semanticSourceObservationFingerprint(observation({
    collectedAt: 2_100,
    payload: traderEvent({ collectedAt: 2_100 }),
  }));
  const second = semanticSourceObservationFingerprint(observation({
    collectedAt: 9_900,
    payload: traderEvent({ collectedAt: 9_900 }),
  }));

  expect(second).toBe(first);
});

it("changes the semantic fingerprint when a business field changes", () => {
  const first = semanticSourceObservationFingerprint(observation({
    payload: traderEvent({ amountUsd: 100 }),
  }));
  const second = semanticSourceObservationFingerprint(observation({
    payload: traderEvent({ amountUsd: 125 }),
  }));

  expect(second).not.toBe(first);
});
```

- [ ] **Step 2: Run the tests and verify failure**

Run:

```bash
pnpm exec vitest run packages/domain/test/source-observation.test.ts
```

Expected: FAIL because `semanticSourceObservationFingerprint` does not exist.

- [ ] **Step 3: Implement the versioned fingerprint contract**

Add these exports:

```ts
export const SOURCE_OBSERVATION_FINGERPRINT_VERSION = 2;

export type SourceObservationWriteResult =
  | Readonly<{ status: "inserted" }>
  | Readonly<{ status: "duplicate" }>
  | Readonly<{ status: "conflict"; conflictId: string }>;

export function semanticSourceObservationFingerprint(
  observation: SourceObservation,
): string;
```

Implement field-aware normalization. Remove top-level `collectedAt`. When the payload is a TraderEvent-shaped object, remove only its top-level `collectedAt`. Keep all other fields. Stable-sort object keys before hashing.

- [ ] **Step 4: Add lazy legacy-fingerprint compatibility tests**

Add database tests proving an existing version-1 row is compared semantically and lazily upgraded rather than reported as a conflict.

```ts
expect(store.saveObservation(recollected)).toEqual({ status: "duplicate" });
expect(readFingerprintVersion(database, recollected.observationId)).toBe(2);
```

- [ ] **Step 5: Implement fingerprint version storage**

Add `fingerprint_version INTEGER NOT NULL DEFAULT 1` to `source_observations` through `ensureColumn`. New rows use version `2`. Existing version-1 rows are reconstructed from stored columns, compared with the version-2 semantic fingerprint, and lazily upgraded after a semantic match.

- [ ] **Step 6: Run focused tests**

```bash
pnpm exec vitest run \
  packages/domain/test/source-observation.test.ts \
  packages/database/test/source-ledger-store.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/domain/src/source-observation.ts \
  packages/domain/test/source-observation.test.ts \
  packages/database/src/source-ledger-store.ts \
  packages/database/test/source-ledger-store.test.ts
git commit -m "fix: make source observation fingerprints semantic"
```

### Task 2: Preserve Genuine Observation Conflicts

**Files:**

- Modify: `packages/database/src/source-ledger-store.ts`
- Modify: `packages/database/src/migrations.ts`
- Modify: `packages/database/test/source-ledger-store.test.ts`

- [ ] **Step 1: Write failing conflict-ledger tests**

```ts
it("aggregates a genuine revision without throwing", () => {
  expect(store.saveObservation(original)).toEqual({ status: "inserted" });
  const first = store.saveObservation(revised);
  const second = store.saveObservation(revised);

  expect(first).toMatchObject({ status: "conflict" });
  expect(second).toEqual(first);
  expect(conflicts(database)).toEqual([
    expect.objectContaining({ occurrenceCount: 2, resolutionStatus: "open" }),
  ]);
});
```

- [ ] **Step 2: Run the test and verify failure**

```bash
pnpm exec vitest run packages/database/test/source-ledger-store.test.ts
```

Expected: FAIL because conflict persistence and the new result contract are absent.

- [ ] **Step 3: Add the conflict schema**

Create `source_observation_conflicts` with the fields and unique key defined in the SPAC. Add indexes on `observation_id`, `resolution_status`, and `last_seen_at`.

- [ ] **Step 4: Implement conflict aggregation**

Compute:

```ts
const conflictId = createHash("sha256")
  .update(observation.observationId)
  .update("\u0000")
  .update(incomingFingerprint)
  .digest("hex");
```

Use `INSERT ... ON CONFLICT(conflict_id) DO UPDATE` to increment `occurrence_count` and update `last_seen_at`. Return `{ status: "conflict", conflictId }` without throwing.

- [ ] **Step 5: Run focused tests**

```bash
pnpm exec vitest run packages/database/test/source-ledger-store.test.ts
```

Expected: PASS, including exact duplicates, collection-time duplicates, genuine conflicts, and restart persistence.

- [ ] **Step 6: Commit**

```bash
git add packages/database/src/source-ledger-store.ts \
  packages/database/src/migrations.ts \
  packages/database/test/source-ledger-store.test.ts
git commit -m "feat: preserve source observation conflicts"
```

### Task 3: Make Ingestion Duplicate- and Conflict-aware

**Files:**

- Modify: `packages/collectors/src/source-observation-ingestor.ts`
- Modify: `packages/collectors/test/source-observation-ingestor.test.ts`
- Modify: `apps/scanner/src/runtime.ts`
- Modify: `apps/scanner/test/source-observation-boundary.test.ts`
- Modify: `apps/scanner/test/runtime.test.ts`

- [ ] **Step 1: Write failing collector tests**

Extend the result shape:

```ts
interface SourceObservationIngestResult {
  observationsInserted: number;
  eventsInserted: number;
  duplicateObservations: number;
  duplicateEvents: number;
  conflictingObservations: number;
}
```

Test these rules:

```ts
it("repairs a missing normalized event after a semantic duplicate", async () => {
  sourceLedger.saveObservation = () => ({ status: "duplicate" });
  eventRepository.insertTraderEvent = () => ({ inserted: true });
  expect((await ingestor.ingest(input)).eventsInserted).toBe(1);
});

it("quarantines a conflicting observation without inserting its event", async () => {
  sourceLedger.saveObservation = () => ({ status: "conflict", conflictId: "conflict-1" });
  await expect(ingestor.ingest(input)).resolves.toMatchObject({
    conflictingObservations: 1,
    eventsInserted: 0,
  });
});
```

- [ ] **Step 2: Run the collector and scanner boundary tests**

```bash
pnpm exec vitest run \
  packages/collectors/test/source-observation-ingestor.test.ts \
  apps/scanner/test/source-observation-boundary.test.ts \
  apps/scanner/test/runtime.test.ts
```

Expected: FAIL against the old `{ inserted: boolean }` contract.

- [ ] **Step 3: Update the collector ingestion flow**

Use the new discriminated result. For `inserted` and `duplicate`, attempt normalized event insertion so an interrupted earlier write can be repaired. For `conflict`, do not insert the event.

- [ ] **Step 4: Update scanner runtime processing**

In the direct scanner path:

```ts
const observationResult = sourceLedger.saveObservation(sourceObservation);
if (observationResult.status === "conflict") {
  conflictReporter.record(observationResult.conflictId, collectorName);
  continue;
}

const eventResult = repository.insertTraderEvent(event);
if (!eventResult.inserted) continue;
```

This preserves repair behavior while preventing duplicate events from reaching aggregation and signal evaluation repeatedly.

- [ ] **Step 5: Run focused tests**

```bash
pnpm exec vitest run \
  packages/collectors/test/source-observation-ingestor.test.ts \
  apps/scanner/test/source-observation-boundary.test.ts \
  apps/scanner/test/runtime.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/collectors/src/source-observation-ingestor.ts \
  packages/collectors/test/source-observation-ingestor.test.ts \
  apps/scanner/src/runtime.ts \
  apps/scanner/test/source-observation-boundary.test.ts \
  apps/scanner/test/runtime.test.ts
git commit -m "fix: isolate duplicate and conflicting observations"
```

### Task 4: Bound Scanner Errors and Disk Usage

**Files:**

- Create: `apps/scanner/src/error-aggregator.ts`
- Create: `apps/scanner/src/collector-backoff.ts`
- Create: `apps/scanner/src/disk-pressure-guard.ts`
- Create: `apps/scanner/test/error-aggregator.test.ts`
- Create: `apps/scanner/test/collector-backoff.test.ts`
- Create: `apps/scanner/test/disk-pressure-guard.test.ts`
- Modify: `apps/scanner/src/config.ts`
- Modify: `apps/scanner/src/runtime.ts`
- Modify: `apps/scanner/src/cli.ts`
- Modify: `deployment/systemd/address-radar-scanner.service`
- Modify: `tests/deployment/systemd-units.test.ts`

- [ ] **Step 1: Write failing error aggregation tests**

```ts
it("emits one summary per key and window", () => {
  const emit = vi.fn();
  const reporter = createErrorAggregator({ windowMs: 60_000, emit, now });
  for (let index = 0; index < 1_000; index += 1) {
    reporter.record({ code: "source_conflict", collector: "fomo_history" });
  }
  now.advance(60_000);
  reporter.flush();

  expect(emit).toHaveBeenCalledTimes(1);
  expect(emit).toHaveBeenCalledWith(expect.objectContaining({ count: 1_000 }));
});
```

- [ ] **Step 2: Write failing backoff tests**

Verify `1s -> 5s -> 30s -> 2m -> 10m`, deterministic injected jitter, collector isolation, and reset after success.

- [ ] **Step 3: Write failing disk guard tests**

```ts
it.each([
  [0.79, "healthy"],
  [0.80, "warning"],
  [0.88, "paused"],
  [0.92, "critical"],
])("maps usage %s to %s", (usedRatio, expected) => {
  expect(classifyDiskPressure(usedRatio)).toBe(expected);
});

it("requires recovery below 80 percent before resuming", () => {
  const guard = createDiskPressureGuard();
  expect(guard.update(0.89).ingestionAllowed).toBe(false);
  expect(guard.update(0.84).ingestionAllowed).toBe(false);
  expect(guard.update(0.79).ingestionAllowed).toBe(true);
});
```

- [ ] **Step 4: Run tests and verify failure**

```bash
pnpm exec vitest run \
  apps/scanner/test/error-aggregator.test.ts \
  apps/scanner/test/collector-backoff.test.ts \
  apps/scanner/test/disk-pressure-guard.test.ts \
  tests/deployment/systemd-units.test.ts
```

Expected: FAIL because the modules and unit limits do not exist.

- [ ] **Step 5: Implement isolated resilience modules**

Use dependency injection for clock, random jitter, log emitter, and filesystem usage reader. `disk-pressure-guard.ts` uses `statfsSync` only in its production adapter; pure classification remains testable without filesystem access.

- [ ] **Step 6: Wire scanner runtime**

Before each collector run, check disk state and collector backoff. Do not invoke paused collectors. Record success to reset backoff. Aggregate expected conflicts separately from unexpected exceptions.

- [ ] **Step 7: Add scanner configuration**

Add validated defaults:

```text
ADDRESS_RADAR_SCANNER_ERROR_WINDOW_MS=60000
ADDRESS_RADAR_SCANNER_DISK_SAMPLE_MS=60000
ADDRESS_RADAR_SCANNER_DISK_WARNING_PERCENT=80
ADDRESS_RADAR_SCANNER_DISK_PAUSE_PERCENT=88
ADDRESS_RADAR_SCANNER_DISK_CRITICAL_PERCENT=92
ADDRESS_RADAR_SCANNER_DISK_RESUME_PERCENT=80
```

- [ ] **Step 8: Add systemd safety limits**

Add under `[Service]`:

```ini
LogRateLimitIntervalSec=30s
LogRateLimitBurst=200
```

- [ ] **Step 9: Run focused tests and scanner typecheck**

```bash
pnpm exec vitest run \
  apps/scanner/test/error-aggregator.test.ts \
  apps/scanner/test/collector-backoff.test.ts \
  apps/scanner/test/disk-pressure-guard.test.ts \
  apps/scanner/test/runtime.test.ts \
  tests/deployment/systemd-units.test.ts
pnpm --filter @address-radar/scanner typecheck
```

Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add apps/scanner deployment/systemd/address-radar-scanner.service \
  tests/deployment/systemd-units.test.ts
git commit -m "feat: bound scanner errors and disk pressure"
```

### Task 5: Add Durable Blocked-source Jobs

**Files:**

- Modify: `packages/domain/src/automation-job.ts`
- Modify: `packages/database/src/automation-job-store.ts`
- Modify: `packages/database/test/automation-job-store.test.ts`
- Modify: `apps/automation/src/scheduler.ts`
- Modify: `apps/automation/test/scheduler.test.ts`

- [ ] **Step 1: Write failing status and backoff tests**

Add `blocked_source` to `AutomationJobStatus` and verify the schedule:

```ts
expect(blockedSourceDelayMs(1)).toBe(5 * 60_000);
expect(blockedSourceDelayMs(2)).toBe(30 * 60_000);
expect(blockedSourceDelayMs(3)).toBe(2 * 60 * 60_000);
expect(blockedSourceDelayMs(12)).toBe(2 * 60 * 60_000);
```

Test that blocked jobs are excluded from normal `dueLanes` and `claim` even when their safety check is due.

- [ ] **Step 2: Run tests and verify failure**

```bash
pnpm exec vitest run \
  packages/database/test/automation-job-store.test.ts \
  apps/automation/test/scheduler.test.ts
```

Expected: FAIL because `blocked_source` and wake APIs do not exist.

- [ ] **Step 3: Add store APIs**

```ts
blockForSource(
  jobId: string,
  owner: string,
  result: {
    missing: readonly string[];
    safetyCheckAt: number;
    updatedAt: number;
  },
): void;

wakeBlockedBySubject(subjectKey: string, now: number): number;

blockedDueForSafetyCheck(now: number, limit: number): readonly AutomationJob[];
```

Store missing prerequisite codes as canonical JSON in `last_error` for compatibility, and add dedicated columns through migration when required for indexed wakeup.

- [ ] **Step 4: Keep blocked jobs outside hot scheduling**

The scheduler never claims `blocked_source` through the normal runnable query. A separate bounded readiness pass checks at most 100 safety-due blocked jobs per planning cycle.

- [ ] **Step 5: Run tests**

```bash
pnpm exec vitest run \
  packages/database/test/automation-job-store.test.ts \
  apps/automation/test/scheduler.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/domain/src/automation-job.ts \
  packages/database/src/automation-job-store.ts \
  packages/database/test/automation-job-store.test.ts \
  apps/automation/src/scheduler.ts \
  apps/automation/test/scheduler.test.ts
git commit -m "feat: park source-blocked automation jobs"
```

### Task 6: Gate Candidate Evidence on Data Readiness

**Files:**

- Create: `apps/automation/src/candidate-readiness.ts`
- Create: `apps/automation/test/candidate-readiness.test.ts`
- Modify: `apps/automation/src/candidate-evidence-worker.ts`
- Modify: `apps/automation/test/candidate-evidence-worker.test.ts`
- Modify: `packages/database/src/source-ledger-store.ts`
- Modify: `packages/database/test/source-ledger-store.test.ts`

- [ ] **Step 1: Write readiness classification tests**

```ts
it.each([
  [{ identity: true, market: true, milestone: true }, { status: "ready" }],
  [{ identity: true, market: false, milestone: true }, { status: "blocked", missing: ["price_history"] }],
  [{ identity: true, market: true, milestone: false }, { status: "blocked", missing: ["milestone"] }],
])("classifies candidate prerequisites", (input, expected) => {
  expect(evaluateCandidateReadiness(input)).toMatchObject(expected);
});
```

- [ ] **Step 2: Write recovery routing tests**

Verify missing price history creates `market_enrichment`; missing milestones create `milestone_early_buyers`; unsupported identities terminate with an explicit reason.

- [ ] **Step 3: Run tests and verify failure**

```bash
pnpm exec vitest run \
  apps/automation/test/candidate-readiness.test.ts \
  apps/automation/test/candidate-evidence-worker.test.ts
```

Expected: FAIL because readiness gating does not exist.

- [ ] **Step 4: Implement ready-only dispatch**

The dispatcher evaluates readiness before enqueuing runnable candidate work. Blocked subjects create or update recovery work and a blocked job record; they do not enter the hot pending queue.

- [ ] **Step 5: Add transactional readiness notifications**

Add `automation_readiness_notifications`:

```sql
CREATE TABLE IF NOT EXISTS automation_readiness_notifications (
  notification_id TEXT PRIMARY KEY,
  subject_key TEXT NOT NULL,
  dimension TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  consumed_at INTEGER
);
CREATE INDEX IF NOT EXISTS automation_readiness_unconsumed
  ON automation_readiness_notifications(consumed_at, observed_at);
```

`saveTokenObservation` and `saveTokenMarketSnapshot` emit notifications in the same write transaction when market or milestone readiness improves.

- [ ] **Step 6: Implement bounded wake consumption**

Automation consumes at most 500 notifications per planning pass, wakes affected subjects idempotently, and marks notifications consumed only after the wake succeeds.

- [ ] **Step 7: Run focused tests**

```bash
pnpm exec vitest run \
  apps/automation/test/candidate-readiness.test.ts \
  apps/automation/test/candidate-evidence-worker.test.ts \
  packages/database/test/source-ledger-store.test.ts \
  apps/automation/test/restart-recovery.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/automation/src/candidate-readiness.ts \
  apps/automation/test/candidate-readiness.test.ts \
  apps/automation/src/candidate-evidence-worker.ts \
  apps/automation/test/candidate-evidence-worker.test.ts \
  packages/database/src/source-ledger-store.ts \
  packages/database/test/source-ledger-store.test.ts
git commit -m "feat: wake candidate evidence from source readiness"
```

### Task 7: Guarantee Fair Progress by Job Type

**Files:**

- Create: `apps/automation/src/job-type-fairness.ts`
- Create: `apps/automation/test/job-type-fairness.test.ts`
- Modify: `packages/database/src/automation-job-store.ts`
- Modify: `packages/database/test/automation-job-store.test.ts`
- Modify: `apps/automation/src/scheduler.ts`
- Modify: `apps/automation/test/scheduler.test.ts`
- Modify: `apps/automation/src/config.ts`
- Modify: `apps/automation/test/config.test.ts`

- [ ] **Step 1: Write failing weighted fairness tests**

```ts
it("gives every runnable type a slot in each twenty-slot window", () => {
  const selector = createJobTypeFairness({
    weights: {
      trader_lightweight_evaluation: 35,
      candidate_evidence: 25,
      ability_evaluation: 20,
      initial_wallet_backfill: 10,
      historical_token_partition: 10,
    },
  });
  const selected = Array.from({ length: 20 }, () => selector.select(allTypes));
  expect(new Set(selected)).toEqual(new Set(allTypes));
});
```

Add a regression test with 205 priority-20 blocked candidates, 10,869 lightweight jobs, and 6,138 ability jobs. Blocked candidates must receive no hot slots, and ability work must be selected inside the first 20 executions.

- [ ] **Step 2: Run tests and verify failure**

```bash
pnpm exec vitest run \
  apps/automation/test/job-type-fairness.test.ts \
  apps/automation/test/scheduler.test.ts \
  packages/database/test/automation-job-store.test.ts
```

Expected: FAIL because claiming is lane-only.

- [ ] **Step 3: Add type-aware store queries**

```ts
dueJobTypes(
  lane: AutomationLane,
  now: number,
  enabledJobTypes?: readonly string[],
): readonly string[];

claim(
  lane: AutomationLane,
  jobType: string,
  now: number,
  leaseMs: number,
  owner: string,
): AutomationJob | null;
```

Within a selected job type, order by effective aged priority, `next_attempt_at`, `created_at`, and `job_id`.

- [ ] **Step 4: Implement weighted deficit round-robin**

Persist enough selector state in `automation_lane_state` to recover deterministic fairness after restart. Redistribute empty-type capacity without resetting other deficits.

- [ ] **Step 5: Add validated weight configuration**

```text
ADDRESS_RADAR_JOB_WEIGHT_TRADER_LIGHTWEIGHT=35
ADDRESS_RADAR_JOB_WEIGHT_CANDIDATE_EVIDENCE=25
ADDRESS_RADAR_JOB_WEIGHT_ABILITY_EVALUATION=20
ADDRESS_RADAR_JOB_WEIGHT_INITIAL_WALLET_BACKFILL=10
ADDRESS_RADAR_JOB_WEIGHT_HISTORICAL_TOKEN_PARTITION=10
```

Require positive integers and a total of `100`.

- [ ] **Step 6: Run focused tests**

```bash
pnpm exec vitest run \
  apps/automation/test/job-type-fairness.test.ts \
  apps/automation/test/scheduler.test.ts \
  packages/database/test/automation-job-store.test.ts \
  apps/automation/test/config.test.ts \
  apps/automation/test/restart-recovery.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/automation/src/job-type-fairness.ts \
  apps/automation/test/job-type-fairness.test.ts \
  apps/automation/src/scheduler.ts \
  apps/automation/test/scheduler.test.ts \
  apps/automation/src/config.ts \
  apps/automation/test/config.test.ts \
  packages/database/src/automation-job-store.ts \
  packages/database/test/automation-job-store.test.ts
git commit -m "feat: schedule automation fairly by job type"
```

### Task 8: Add Planner High-water Marks and Durable Cursors

**Files:**

- Modify: `apps/automation/src/trader-backfill-planner.ts`
- Modify: `apps/automation/test/trader-backfill-planner.test.ts`
- Modify: `apps/automation/src/token-partition-planner.ts`
- Modify: `apps/automation/test/token-partition-planner.test.ts`
- Modify: `apps/automation/src/candidate-evidence-worker.ts`
- Modify: `apps/automation/test/candidate-evidence-worker.test.ts`
- Modify: `apps/automation/src/trader-ability-worker.ts`
- Modify: `apps/automation/test/trader-ability-worker.test.ts`
- Modify: `apps/automation/src/config.ts`
- Modify: `apps/automation/test/config.test.ts`

- [ ] **Step 1: Write failing high-water tests**

For each planner, seed the store at its limit and assert no additional runnable jobs are created and the durable cursor does not advance past unplanned subjects.

```ts
expect(planner.seed(now)).toEqual({
  planned: 0,
  pausedByHighWater: true,
  cursor: "trader-2000",
});
```

- [ ] **Step 2: Add pending-count store support**

Expose `runnableCount(jobType)` and keep it indexed by `(job_type, status, next_attempt_at)`.

- [ ] **Step 3: Implement thresholds and 70% resume hysteresis**

Use the SPAC defaults. Store planner cursor state in `automation_runtime_snapshots` so restart resumes from the same subject.

- [ ] **Step 4: Ensure dispatchers remain singleton**

Candidate and ability dispatcher idempotency keys must be stable. A dispatcher cannot enqueue a second copy while one is pending, leased, running, or blocked.

- [ ] **Step 5: Run planner tests**

```bash
pnpm exec vitest run \
  apps/automation/test/trader-backfill-planner.test.ts \
  apps/automation/test/token-partition-planner.test.ts \
  apps/automation/test/candidate-evidence-worker.test.ts \
  apps/automation/test/trader-ability-worker.test.ts \
  apps/automation/test/restart-recovery.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/automation/src apps/automation/test
git commit -m "feat: apply automation planner backpressure"
```

### Task 9: Expose Runtime Resilience Metrics

**Files:**

- Modify: `packages/observability/src/runtime-quality.ts`
- Modify: `packages/observability/test/runtime-quality.test.ts`
- Modify: `apps/console/src/application.ts`
- Modify: `apps/console/test/automation-funnel.test.ts`
- Modify: `apps/console/test/automation-operations.test.ts`

- [ ] **Step 1: Write failing runtime quality tests**

Add fields for:

```ts
interface AutomationResilienceQuality {
  queueByJobTypeAndStatus: Readonly<Record<string, Readonly<Record<string, number>>>>;
  oldestRunnableAgeMs: Readonly<Record<string, number | null>>;
  completedLastTenMinutes: Readonly<Record<string, number>>;
  blockedReasons: Readonly<Record<string, number>>;
  schedulingShare: Readonly<Record<string, number>>;
  sourceDuplicateRate: number;
  sourceConflictRate: number;
  scannerLogBytesPerMinute: number;
  databaseBytes: number;
  walBytes: number;
  rootDiskUsedPercent: number;
  diskPressureState: "healthy" | "warning" | "paused" | "critical";
}
```

- [ ] **Step 2: Add Chinese operator-state tests**

Verify raw states render as:

```text
blocked_source -> 等待前置数据
source_observation_conflict -> 来源事件内容冲突
disk_pressure_paused -> 磁盘压力，采集已暂停
queue_starvation -> 任务长时间未获得执行机会
```

- [ ] **Step 3: Run tests and verify failure**

```bash
pnpm exec vitest run \
  packages/observability/test/runtime-quality.test.ts \
  apps/console/test/automation-funnel.test.ts \
  apps/console/test/automation-operations.test.ts
```

Expected: FAIL because resilience fields and labels are absent.

- [ ] **Step 4: Implement snapshot queries and rendering**

Use bounded indexed aggregate queries. Do not scan full payload columns for every console refresh. Show operator descriptions first and raw IDs as secondary diagnostics.

- [ ] **Step 5: Run focused tests**

```bash
pnpm exec vitest run \
  packages/observability/test/runtime-quality.test.ts \
  apps/console/test/automation-funnel.test.ts \
  apps/console/test/automation-operations.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/observability apps/console
git commit -m "feat: expose scanner and automation resilience"
```

### Task 10: Build the Bounded Queue Migration Tool

**Files:**

- Create: `scripts/migrate-automation-resilience.ts`
- Create: `tests/migration/automation-resilience-migration.test.ts`
- Modify: `packages/database/src/migrations.ts`
- Modify: `package.json`

- [ ] **Step 1: Write failing migration tests**

Seed the current production-shaped backlog:

```ts
seedJobs({ type: "candidate_evidence", status: "waiting_source", count: 205 });
seedJobs({ type: "candidate_evidence", status: "pending", count: 22_894 });
seedJobs({ type: "ability_evaluation", status: "pending", count: 6_138 });
```

Assert:

- Missing-prerequisite candidates become `blocked_source`.
- Ready candidates stay pending up to the high-water limit.
- Overflow candidates remain durably discoverable from the planning cursor.
- Ability jobs are preserved.
- No rows are deleted.
- Rerunning the migration produces zero additional changes.

- [ ] **Step 2: Run the migration test and verify failure**

```bash
pnpm exec vitest run tests/migration/automation-resilience-migration.test.ts
```

Expected: FAIL because the migration tool does not exist.

- [ ] **Step 3: Implement dry-run and apply modes**

CLI contract:

```text
pnpm migrate:automation-resilience -- --database PATH --dry-run --batch-size 500
pnpm migrate:automation-resilience -- --database PATH --apply --batch-size 500
```

Dry-run prints counts only. Apply processes one transaction per batch and writes `migration_audit` records containing before/after counts, cursor, strategy version, and timestamp.

- [ ] **Step 4: Add package script**

```json
{
  "migrate:automation-resilience": "tsx scripts/migrate-automation-resilience.ts"
}
```

- [ ] **Step 5: Run migration and restart tests**

```bash
pnpm exec vitest run \
  tests/migration/automation-resilience-migration.test.ts \
  apps/automation/test/restart-recovery.test.ts \
  apps/automation/test/full-pipeline-replay.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/migrate-automation-resilience.ts \
  tests/migration/automation-resilience-migration.test.ts \
  packages/database/src/migrations.ts package.json
git commit -m "feat: migrate automation queues safely"
```

### Task 11: Run Full Local Verification

**Files:**

- Modify only files required to fix failures introduced by Tasks 1-10

- [ ] **Step 1: Run focused resilience suites**

```bash
pnpm exec vitest run \
  packages/domain/test/source-observation.test.ts \
  packages/database/test/source-ledger-store.test.ts \
  packages/database/test/automation-job-store.test.ts \
  packages/collectors/test/source-observation-ingestor.test.ts \
  apps/scanner/test \
  apps/automation/test \
  packages/observability/test/runtime-quality.test.ts \
  apps/console/test/automation-funnel.test.ts \
  apps/console/test/automation-operations.test.ts \
  tests/migration/automation-resilience-migration.test.ts \
  tests/deployment/systemd-units.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run the complete suite and build**

```bash
pnpm test
pnpm typecheck
pnpm build
pnpm smoke:packages
```

Expected: all commands exit `0`.

- [ ] **Step 3: Run the four-hour local SQLite soak**

Use a production-shaped fixture with all five job types, five chains, source-blocked jobs, repeated observations, and disk-state simulation. Assert:

```text
sqlite_busy_errors = 0
unbounded_conflict_logs = 0
job_types_with_no_progress = 0
hot_slots_used_by_blocked_source <= 10%
gateway_deliveries = 0
```

- [ ] **Step 4: Commit verification-only fixes**

```bash
git add -A
git commit -m "test: verify automation resilience pipeline"
```

### Task 12: Update Operations Documentation

**Files:**

- Modify: `docs/operations/automation-backfill-and-token-mining.md`
- Modify: `docs/operations/scanner-conflict-incident.md`
- Create: `docs/operations/automation-resilience-rollout.md`
- Modify: `deployment/address-radar.env.example`

- [ ] **Step 1: Document all new configuration**

Include scanner backoff, disk thresholds, job weights, queue high-water marks, readiness batch size, and blocked-source delays with production defaults.

- [ ] **Step 2: Document production acceptance queries**

Provide read-only SQL for queue status, blocked reasons, scheduling share, conflict rate, readiness notifications, signal outbox, and migration audit.

- [ ] **Step 3: Document rollback**

Specify immutable release switchback, old-release schema compatibility, database restore conditions, service order, and health checks.

- [ ] **Step 4: Commit**

```bash
git add docs/operations deployment/address-radar.env.example
git commit -m "docs: add automation resilience rollout guide"
```

### Task 13: Deploy in Reversible Production Stages

**Files:**

- No source changes unless a verified production-only defect is found

- [ ] **Step 1: Create and validate a fresh backup**

```bash
ssh ubuntu@152.32.185.240 '
  set -euo pipefail
  sudo systemctl start address-radar-backup.service
  latest=$(sudo find /var/lib/address-radar/backups -name address-radar.db -type f \
    -printf "%T@ %p\n" | sort -nr | head -1 | cut -d" " -f2-)
  sudo -u address-radar node -e "
    const { DatabaseSync } = require(\"node:sqlite\");
    const db = new DatabaseSync(process.argv[1], { readOnly: true });
    if (db.prepare(\"PRAGMA quick_check\").get().quick_check !== \"ok\") process.exit(1);
  " "$latest"
'
```

Expected: backup quick check returns `ok`.

- [ ] **Step 2: Build an immutable server release**

Install from the lockfile, run build, package smoke checks, focused resilience tests, and systemd unit tests before changing `/opt/address-radar/current`.

- [ ] **Step 3: Run queue migration dry-run**

```bash
pnpm migrate:automation-resilience -- \
  --database /var/lib/address-radar/address-radar.db \
  --dry-run \
  --batch-size 500
```

Expected: report contains no deletions, preserves ability jobs, and classifies source-missing candidates as blocked.

- [ ] **Step 4: Apply the queue migration with scanner stopped**

Run apply mode and verify `migration_audit`. Keep automation execution disabled during migration.

- [ ] **Step 5: Switch the immutable release with rollback trap**

Install updated units, atomically switch the `current` symlink, daemon-reload, and start all services except scanner. Verify `active`, `NRestarts=0`, console health, and Gateway disabled.

- [ ] **Step 6: Resume scanner in shadow mode**

Start scanner and observe for 30 minutes.

Acceptance:

```text
scanner_conflict_stacktrace_loop = 0
scanner_logs_30m < 10 MB
root_disk_growth_30m < 50 MB excluding database evidence growth
scanner_service_restarts = 0
```

- [ ] **Step 7: Enable automation job types cumulatively**

Use this order:

```text
trader_lightweight_evaluation
initial_wallet_backfill
historical_token_partition
candidate_evidence
ability_evaluation
```

Promote only after each enabled type shows real progress without starving prior types.

- [ ] **Step 8: Run four-hour production soak**

Acceptance:

```text
all_services_active = true
all_service_restarts = 0
sqlite_lock_errors = 0
each_runnable_job_type_progresses_within_10m = true
blocked_source_hot_slot_share <= 10%
root_disk_used_percent < 80
gateway_delivery_enabled = false
signal_outbox_count = 0
```

- [ ] **Step 9: Produce the acceptance report**

Record release path, backup path, migration counts, before/after queue state, conflict counts, log growth, disk usage, per-type throughput, five-chain coverage, service status, and rollback pointer.

Do not enable user delivery. That remains a separate user-approved operation.

---

## Final Completion Gate

This plan is complete only when:

- The scanner is live without conflict or log storms.
- Semantic duplicates and genuine revisions are handled according to the SPAC.
- Source-blocked work is event-woken and does not consume hot capacity.
- Every runnable automation job type progresses within ten minutes.
- Planner queues remain below high-water marks.
- Root disk usage remains below 80% during the four-hour production soak.
- No SQLite lock errors or service restarts occur.
- Gateway delivery remains disabled and no signal is delivered to users.
