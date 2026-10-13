import test from "node:test";
import assert from "node:assert/strict";
import { superviseStagedPreservation, superviseSegmentedPreservation, runBoundedPreservationCall, preservationStageMaximumMs, lifecycleSha256, maintenanceHelperPath, sourcePins } from "../run-staged-postgres-preservation-fixture.mjs";
function fixture() {
  let now = 1000000, mono = 1000000, owners = 0, cleanups = 0, stages = 0;
  const events = [], work = [], records = [];
  const ctx = { nonce: "a".repeat(16), database: "radar_rehearsal_" + "a".repeat(16), schema: "schema", role: "role", systemIdentifier: "123" };
  const binding = { ...ctx, root: "/tmp/" + ctx.database, owner: "b".repeat(48), directoryDevice: 1, directoryInode: 2, postmasterPid: 3, postmasterStart: "123", connectionSha256: "c".repeat(64), runnerSha256: "d".repeat(64), sourceReaderSha256: "e".repeat(64), expiryHelperSha256: "f".repeat(64), lifecycleSha256, maintenanceHelperPath };
  const ports = {
    withFixture: async fn => { owners++; try { await fn(ctx); } finally { cleanups++; events.push("cleanup"); } },
    bind: async () => binding, verifyIdentity: async () => binding,
    armExpiry: async () => { events.push("expiry"); },
    verifyExpiry: async (_ctx, r) => ({ rootOwned: true, immutable: true, independent: true, armed: true, identitySha256: r.identitySha256, helperSha256: binding.expiryHelperSha256, expiresAtMs: r.absoluteDeadlineAtMs, recordSha256: "a".repeat(64) }),
    capture: async (_ctx, r) => { events.push("capture"); return { nonce: r.windowNonce, baselineSha256: "a".repeat(64) }; },
    armMaintenance: async (_ctx, r) => ({ ...r, nonce: r.windowNonce, verified: true }), pause: async () => ({ phase: "paused" }),
    restore: async (_ctx, r) => { events.push("restore"); return { status: "restored", nonce: r.windowNonce }; },
    runStage: async (_ctx, r) => {
      work.push(r); stages++; const elapsed = Math.min(14 * 60000, r.timeoutMs); now += elapsed; mono += elapsed;
      const status = r.stage === "calibrate" ? "calibrated" : r.stage === "parity" ? "completed" : stages < 5 ? "yielded_before_transaction" : "import_completed_pending_parity";
      return { invocationId: r.invocationId, identitySha256: r.identitySha256, exitCode: 0, sourcePins, durableChunks: status === "import_completed_pending_parity" ? 1548 : stages * 200,
        freshSourceValidationComplete: true, durableBodyReconciliationComplete: true, parityCounts: { tables: 141, rows: 6023033, chunks: 1548 },
        report: { status, rollbackObserved: true, parityComplete: r.stage === "parity", nativeMetrics: { physicalSqlStatements: 10, commitAttempts: 1, acknowledgedCommits: 1, acknowledgedRollbacks: 1 } } };
    }, verifyInvocationEmpty: async (_ctx, r) => ({ challenge: r.challenge, identitySha256: r.identitySha256,
      proofs: r.invocationIds.map(id => ({ invocationId: id, unit: "address-radar-preservation-invocation-" + _ctx.nonce + "-" + id + ".service",
        recordSha256: "a".repeat(64), instanceSha256: "b".repeat(64), cgroupPopulated: 0, cgroupProcessCount: 0 })) }),
    record: async r => records.push(r),
  };
  return { binding, ports, events, work, records, options: { clock: () => now, monotonic: () => mono }, advance: ms => { now += ms; mono += ms; }, shiftWallClock: ms => { now += ms; }, owners: () => owners, cleanups: () => cleanups };
}
test("legacy export: one callback owns multiple windows and legacy full parity", async () => {
  const f = fixture(), result = await superviseStagedPreservation(f.ports, f.options);
  assert.equal(f.owners(), 1); assert.equal(f.cleanups(), 1); assert.equal(result.parityComplete, true);
  assert.ok(result.windowIndex > 1); assert.equal(new Set(f.work.map(r => r.configName)).size, f.work.length);
  assert.equal(f.events.at(-1), "cleanup"); assert.equal(f.events[0], "expiry");
  assert.ok(f.records.every(r => !JSON.stringify(r).includes("password")));
  assert.ok(f.work.every(r => /^[a-f0-9]{16}$/.test(r.windowNonce)));
});
for (const field of ["rootOwned", "immutable", "independent", "armed"]) test("refuses unverified expiry: " + field, async () => {
  const f = fixture(), original = f.ports.verifyExpiry;
  f.ports.verifyExpiry = async (...args) => ({ ...await original(...args), [field]: false });
  await assert.rejects(superviseStagedPreservation(f.ports, f.options), /expiry_unverified/);
  assert.ok(!f.events.includes("capture")); assert.equal(f.cleanups(), 1);
});
test("capture failure restores before lifecycle cleanup", async () => {
  const f = fixture(); f.ports.capture = async () => { throw new Error("transport"); };
  await assert.rejects(superviseStagedPreservation(f.ports, f.options), /transport/);
  assert.deepEqual(f.events.slice(-2), ["restore", "cleanup"]);
});
test("unknown COMMIT fails clean and cannot become a yield", async () => {
  const f = fixture(), original = f.ports.runStage;
  f.ports.runStage = async (...args) => { const r = await original(...args); r.report.nativeMetrics.acknowledgedCommits = 0; return r; };
  await assert.rejects(superviseStagedPreservation(f.ports, f.options), /commit_unknown/);
  assert.deepEqual(f.events.slice(-2), ["restore", "cleanup"]);
});
test("zero progress terminates and restores", async () => {
  const f = fixture(), original = f.ports.runStage;
  f.ports.runStage = async (...args) => ({ ...await original(...args), durableChunks: 0 });
  await assert.rejects(superviseStagedPreservation(f.ports, f.options), /zero_progress/);
  assert.equal(f.cleanups(), 1);
});
test("false parity completion is rejected", async () => {
  const f = fixture(), original = f.ports.runStage;
  f.ports.runStage = async (...args) => { const r = await original(...args); if (r.report.status === "completed") r.parityCounts.rows--; return r; };
  await assert.rejects(superviseStagedPreservation(f.ports, f.options), /parity_incomplete/);
  assert.equal(f.cleanups(), 1);
});
test("absolute expiry and stale capture cannot proceed", async () => {
  const f = fixture(), capture = f.ports.capture;
  f.ports.capture = async (...args) => { const r = await capture(...args); f.advance(60000); return r; };
  await assert.rejects(superviseStagedPreservation(f.ports, f.options), /capture_stale/);
  assert.deepEqual(f.events.slice(-2), ["restore", "cleanup"]);
});

test("calibrate and install retain 180-second budgets; import and parity retain 900", () => {
  assert.equal(preservationStageMaximumMs("calibrate"), 180000);
  assert.equal(preservationStageMaximumMs("install"), 180000);
  assert.equal(preservationStageMaximumMs("import"), 900000);
  assert.equal(preservationStageMaximumMs("parity"), 900000);
});
test("calibration exceeding 180 seconds fails and restores", async () => {
  const f = fixture(), original = f.ports.runStage;
  f.ports.runStage = async (...args) => { const r = await original(...args); f.advance(1); return r; };
  await assert.rejects(superviseStagedPreservation(f.ports, f.options), /stage_overrun/);
  assert.equal(f.work[0].deadlineAtMs, 1000000 + 180000);
  assert.deepEqual(f.events.slice(-2), ["restore", "cleanup"]);
});
test("actual short expiry bounds every work and restoration deadline", async () => {
  const f = fixture(), original = f.ports.verifyExpiry, expiry = 1000000 + 65 * 60000, restores = [];
  f.ports.verifyExpiry = async (...args) => ({ ...await original(...args), expiresAtMs: expiry });
  const restore = f.ports.restore;
  f.ports.restore = async (ctx, r) => { restores.push(r); return restore(ctx, r); };
  await assert.rejects(superviseStagedPreservation(f.ports, f.options), /window_budget/);
  assert.ok(f.work.length > 0);
  assert.ok(f.work.every(r => r.deadlineAtMs <= expiry - 240000 - 40000 && r.expiresAtMs === expiry));
  assert.ok(restores.every(r => r.deadlineAtMs <= expiry - 40000));
  assert.equal(f.cleanups(), 1);
});
test("near expiry refuses a new window before capture", async () => {
  const f = fixture(), original = f.ports.verifyExpiry;
  f.ports.verifyExpiry = async (...args) => ({ ...await original(...args), expiresAtMs: 1000000 + 300000 });
  await assert.rejects(superviseStagedPreservation(f.ports, f.options), /window_budget/);
  assert.equal(f.work.length, 0); assert.ok(!f.events.includes("capture")); assert.equal(f.cleanups(), 1);
});
for (const field of ["expiresAtMs", "recordSha256"]) test("immutable actual expiry rejects changed " + field, async () => {
  const f = fixture(), original = f.ports.verifyExpiry; let calls = 0;
  f.ports.verifyExpiry = async (...args) => {
    const proof = await original(...args);
    if (++calls > 1) proof[field] = field === "expiresAtMs" ? proof.expiresAtMs - 1 : "b".repeat(64);
    return proof;
  };
  await assert.rejects(superviseStagedPreservation(f.ports, f.options), /expiry_identity_changed/);
  assert.ok(!f.events.includes("capture")); assert.equal(f.cleanups(), 1);
});

test("clipped expiry stage cannot overrun under wall-clock rollback", async () => {
  const f = fixture(), expiry = f.ports.verifyExpiry, original = f.ports.runStage;
  f.ports.verifyExpiry = async (...args) => ({ ...await expiry(...args), expiresAtMs: 1000000 + 65 * 60000 });
  f.ports.runStage = async (ctx, r) => {
    const value = await original(ctx, r);
    if (r.stage === "import") { f.advance(r.timeoutMs - Math.min(14 * 60000, r.timeoutMs) + 1); f.shiftWallClock(-600000); }
    return value;
  };
  await assert.rejects(superviseStagedPreservation(f.ports, f.options), /stage_overrun/);
  assert.equal(f.work[1].timeoutMs, 900000);
  assert.deepEqual(f.events.slice(-2), ["restore", "cleanup"]);
});
test("clipped window stage cannot overrun under wall-clock rollback", async () => {
  const f = fixture(), original = f.ports.runStage;
  f.ports.runStage = async (ctx, r) => {
    const value = await original(ctx, r);
    if (r.stage === "import" && r.timeoutMs < 900000) { f.advance(1); f.shiftWallClock(-600000); }
    return value;
  };
  await assert.rejects(superviseStagedPreservation(f.ports, f.options), /stage_overrun/);
  assert.deepEqual(f.events.slice(-2), ["restore", "cleanup"]);
});
test("shortened restore rejects clipped-duration overrun despite wall rollback", async () => {
  const f = fixture(), expiry = f.ports.verifyExpiry, original = f.ports.runStage; let restoration;
  f.ports.verifyExpiry = async (...args) => ({ ...await expiry(...args), expiresAtMs: 1000000 + 65 * 60000 });
  f.ports.runStage = async (ctx, r) => {
    const value = await original(ctx, r);
    if (r.stage === "import") { f.advance(1000000 + 60 * 60000 - 220000 - f.options.monotonic()); f.shiftWallClock(-600000); }
    return value;
  };
  f.ports.restore = async (_ctx, r) => {
    restoration = r; f.advance(r.timeoutMs + 1); f.shiftWallClock(-600000);
    return { status: "restored", nonce: r.windowNonce };
  };
  await assert.rejects(superviseStagedPreservation(f.ports, f.options), /watchdog_handoff_producer_exit_unproven/);
  assert.equal(restoration, undefined);
  assert.equal(f.cleanups(), 1);
});
test("live abort is scheduled inside clipped budget and awaits port closure", async () => {
  let closed = false, scheduledMs;
  const operation = async (_ctx, r) => new Promise(resolve => r.signal.addEventListener("abort", () => { closed = true; resolve({}); }, { once: true }));
  await assert.rejects(runBoundedPreservationCall(operation, {}, {
    deadlineAtMs: 121000, monotonicDeadlineAtMs: 121000, timeoutMs: 120000,
  }, { clock: () => 1000, monotonic: () => 1000, reason: "stage_overrun",
    schedule: (fn, ms) => { scheduledMs = ms; queueMicrotask(fn); return 1; }, cancel: () => {},
  }), /stage_overrun/);
  assert.equal(scheduledMs, 110000); assert.equal(closed, true);
});
test("expiry proof whitelist rejects injected fields", async () => {
  const f = fixture(), original = f.ports.verifyExpiry;
  f.ports.verifyExpiry = async (...args) => ({ ...await original(...args), nested: { bypass: true } });
  await assert.rejects(superviseStagedPreservation(f.ports, f.options), /expiry_fields/);
  assert.ok(!f.events.includes("capture"));
});

function segmentedFixture() {
  const f = fixture(), binding = f.binding, h = char => char.repeat(64);
  Object.assign(binding, { artifactRoot: "/var/lib/address-radar-rehearsal-artifacts/" + binding.nonce,
    artifactOwner: "a".repeat(48), artifactDevice: 1, artifactInode: 2,
    artifactControlRoot: "/var/lib/address-radar-rehearsal-artifact-control/" + binding.nonce,
    artifactControlDevice: 1, artifactControlInode: 3, artifactLockDevice: 1, artifactLockInode: 4,
    receiptDirectoryDevice: 1, receiptDirectoryInode: 5 });
  binding.receiptDirectory = binding.artifactControlRoot + "/receipts";
  let measurements = 0, verified = 0, imported = 0;
  f.ports.verifyArtifactSeal = async (_ctx, r) => {
    f.events.push("seal-check:" + r.stage);
    return { ...binding, challenge: r.challenge, status: "sealed", identitySha256: r.identitySha256,
      sealSha256: h("b"), receiptDirectoryUid: 0 };
  };
  f.ports.measureDatabaseFreeze = async (_ctx, r) => {
    f.events.push("db-check:" + r.stage);
    return { challenge: r.challenge, identitySha256: r.identitySha256, freezeSha256: h("c"),
      measurementSha256: (++measurements).toString(16).padStart(64, "0"), measuredAtMs: f.options.clock(),
      nativeMeasurementQueries: 3, writerSessionCount: 0, writeAuthorityCount: 0,
      mutationEpochSha256: h("d"), systemIdentifier: binding.systemIdentifier };
  };
  f.ports.runStage = async (_ctx, r) => {
    f.work.push(r); f.events.push("run:" + r.stage);
    f.advance(r.stage === "calibrate" || r.stage === "freeze" ? 1000 : Math.min(14 * 60000, r.timeoutMs));
    const nativeMetrics = { physicalSqlStatements: 10, commitAttempts: 1, acknowledgedCommits: 1,
      acknowledgedRollbacks: 1, finalizeAttempts: r.stage === "finalize" ? 1 : 0,
      acknowledgedFinalizations: r.stage === "finalize" ? 1 : 0 };
    const report = { protocolVersion: 2, stage: r.stage, parityComplete: false, productionAuthorized: false,
      nativeMetrics, sealSha256: h("b"), freezeSha256: h("c") };
    if (r.stage === "calibrate") Object.assign(report, { status: "calibrated", rollbackObserved: true });
    if (r.stage === "import") {
      const startChunk = imported; imported += 774;
      Object.assign(report, { status: imported === 1548 ? "import_segments_exhausted" : "import_segment_committed",
        segment: { startChunk, endChunk: imported, rows: imported === 1548 ? 3023033 : 3000000, sourceSha256: h("e") } });
    }
    if (r.stage === "freeze") report.status = "frozen_pending_verification";
    if (r.stage === "verify") {
      const startChunk = verified; verified += 774;
      Object.assign(report, { status: "segment_verified_pending_finalization",
        segment: { startChunk, endChunk: verified, rows: verified === 1548 ? 3023033 : 3000000,
          sourceSha256: h("e"), targetSha256: h("e") } });
    }
    if (r.stage === "finalize") Object.assign(report, { status: "finalized", parityComplete: true,
      coverageSha256: r.coverageSha256, counts: { tables: 141, rows: 6023033, chunks: 1548 } });
    return { protocolVersion: 2, runnerSha256: binding.runnerSha256, reportSha256: h("f"),
      invocationId: r.invocationId, identitySha256: r.identitySha256, sourcePins, exitCode: 0, report,
      durableChunks: imported, freshSourceValidationComplete: true, durableBodyReconciliationComplete: true };
  };
  return f;
}
test("protocol 2 completes only through import, freeze, independent segments and native finalize ACK", async () => {
  const f = segmentedFixture(), result = await superviseSegmentedPreservation(f.ports, f.options);
  assert.deepEqual(f.work.map(r => r.stage), ["calibrate", "import", "import", "freeze", "verify", "verify", "finalize"]);
  assert.equal(result.protocolVersion, 2); assert.equal(result.parityComplete, true); assert.equal(result.verifiedSegments, 2);
  assert.equal(f.owners(), 1); assert.equal(f.cleanups(), 1); assert.ok(result.windowIndex > 1);
  assert.ok(f.work.filter(r => ["verify", "finalize"].includes(r.stage)).every(r => r.evidenceDirectory === f.binding.receiptDirectory));
  assert.ok(f.records.filter(r => r.stage !== "finalize").every(r => r.parityComplete === false));
  assert.equal(f.events.filter(x => x === "db-check:verify").length, 4);
  assert.equal(f.events.filter(x => x === "db-check:finalize").length, 2);
});
test("protocol 2 stage caps preserve freeze180 and verify/finalize900", () => {
  assert.equal(preservationStageMaximumMs("freeze"), 180000);
  assert.equal(preservationStageMaximumMs("verify"), 900000);
  assert.equal(preservationStageMaximumMs("finalize"), 900000);
});
for (const oldStatus of ["completed", "import_completed_pending_parity"]) test("protocol 2 rejects legacy importer status " + oldStatus, async () => {
  const f = segmentedFixture(), original = f.ports.runStage;
  f.ports.runStage = async (...args) => { const r = await original(...args); if (r.report.stage === "import") r.report.status = oldStatus; return r; };
  await assert.rejects(superviseSegmentedPreservation(f.ports, f.options), /segmented_import_receipt/);
  assert.deepEqual(f.events.slice(-2), ["restore", "cleanup"]);
});
for (const phase of ["verify", "finalize"]) test("live DB freeze drift after " + phase + " prevents completion", async () => {
  const f = segmentedFixture(), original = f.ports.measureDatabaseFreeze; let checks = 0;
  f.ports.measureDatabaseFreeze = async (ctx, r) => { const proof = await original(ctx, r); if (r.stage === phase && ++checks === 2) proof.mutationEpochSha256 = "e".repeat(64); return proof; };
  await assert.rejects(superviseSegmentedPreservation(f.ports, f.options), /database_freeze_changed/);
  assert.ok(!f.records.some(r => r.parityComplete === true)); assert.equal(f.cleanups(), 1);
});
test("artifact seal cannot substitute for missing live DB mutation exclusion", async () => {
  const f = segmentedFixture(), original = f.ports.measureDatabaseFreeze;
  f.ports.measureDatabaseFreeze = async (...args) => ({ ...await original(...args), writeAuthorityCount: 1 });
  await assert.rejects(superviseSegmentedPreservation(f.ports, f.options), /database_freeze_unverified/);
  assert.ok(!f.work.some(r => r.stage === "verify"));
});
test("replayed database measurement is rejected", async () => {
  const f = segmentedFixture(), original = f.ports.measureDatabaseFreeze;
  f.ports.measureDatabaseFreeze = async (...args) => ({ ...await original(...args), measurementSha256: "e".repeat(64) });
  await assert.rejects(superviseSegmentedPreservation(f.ports, f.options), /database_freeze_unverified/);
});
for (const change of [r => { r.report.segment.startChunk++; }, r => { r.report.segment.targetSha256 = "a".repeat(64); }, r => { r.report.segment.rows--; }]) test("verification rejects coverage gap, digest mismatch or incomplete rows " + String(change), async () => {
  const f = segmentedFixture(), original = f.ports.runStage;
  f.ports.runStage = async (...args) => { const r = await original(...args); if (r.report.stage === "verify") change(r); return r; };
  await assert.rejects(superviseSegmentedPreservation(f.ports, f.options), /verification_/);
  assert.ok(!f.work.some(r => r.stage === "finalize"));
});
for (const change of [r => { r.report.nativeMetrics.acknowledgedFinalizations = 0; }, r => { r.report.coverageSha256 = "a".repeat(64); }, r => { r.report.counts.rows--; }]) test("finalization requires native ACK, exact coverage and aggregates " + String(change), async () => {
  const f = segmentedFixture(), original = f.ports.runStage;
  f.ports.runStage = async (...args) => { const r = await original(...args); if (r.report.stage === "finalize") change(r); return r; };
  await assert.rejects(superviseSegmentedPreservation(f.ports, f.options), /finalization_unacknowledged_or_incomplete/);
  assert.ok(!f.records.some(r => r.parityComplete === true));
});
test("protocol version cannot be silently downgraded", async () => {
  const f = segmentedFixture(), original = f.ports.runStage;
  f.ports.runStage = async (...args) => { const r = await original(...args); delete r.protocolVersion; return r; };
  await assert.rejects(superviseSegmentedPreservation(f.ports, f.options), /segmented_native_receipt/);
});

test("window admission includes fixed55min watchdog, restoration, cleanup and capture margin", async () => {
 const f = fixture(), original = f.ports.verifyExpiry;
 f.ports.verifyExpiry = async (...args) => ({ ...await original(...args), expiresAtMs: 1000000 + 55 * 60000 + 240000 + 40000 + 60000 - 1 });
 await assert.rejects(superviseStagedPreservation(f.ports, f.options), /window_budget/);
 assert.ok(!f.events.includes("capture")); assert.equal(f.cleanups(), 1);
});
test("local transport failure without independent producer proof hands off watchdog", async () => {
 const f = fixture(); f.ports.runStage = async () => { throw new Error("local_ssh_closed"); };
 f.ports.verifyInvocationEmpty = async () => { throw new Error("independent_proof_unavailable"); };
 await assert.rejects(superviseStagedPreservation(f.ports, f.options), /watchdog_handoff_producer_exit_unproven/);
 assert.ok(!f.events.includes("restore")); assert.equal(f.cleanups(), 1);
 assert.equal(f.records.at(-1).status, "watchdog_handoff_producer_exit_unproven");
});
for (const field of ["cgroupPopulated", "cgroupProcessCount", "unit"]) test("invalid independent invocation proof prevents active restore: " + field, async () => {
 const f = fixture(), original = f.ports.verifyInvocationEmpty;
 f.ports.verifyInvocationEmpty = async (...args) => { const r = await original(...args); r.proofs[0][field] = field === "unit" ? "unrelated.service" : 1; return r; };
 await assert.rejects(superviseStagedPreservation(f.ports, f.options), /watchdog_handoff_producer_exit_unproven/);
 assert.ok(!f.events.includes("restore")); assert.ok(!f.records.some(r => r.status === "restored"));
});

test("clipped restore monotonic duration rejects wall-clock rollback even below240s",async()=>{
 let wall=1000,mono=1000;
 await assert.rejects(runBoundedPreservationCall(async()=>{mono+=220001;wall-=600000;return {};},{},
  {deadlineAtMs:221000,monotonicDeadlineAtMs:221000,timeoutMs:220000},
  {clock:()=>wall,monotonic:()=>mono,reason:"restore_unconfirmed"}),/restore_unconfirmed/);
});


test("fresh pause initiation allows native 95-second scanner closure", async () => {
  const f = fixture();
  f.ports.pause = async (_ctx, r) => {
    assert.equal(r.timeoutMs, 470000);
    assert.equal(r.deadlineAtMs - f.options.clock(), 470000);
    assert.ok(r.signal instanceof AbortSignal);
    f.advance(100000);
    return { phase: "paused" };
  };
  const result = await superviseStagedPreservation(f.ports, f.options);
  assert.equal(result.parityComplete, true);
  assert.equal(f.cleanups(), 1);
});
test("pause completion overrun remains bounded during wall-clock rollback", async () => {
  const f = fixture();
  f.ports.pause = async (_ctx, r) => {
    f.advance(r.timeoutMs + 1);
    f.shiftWallClock(-r.timeoutMs);
    return { phase: "paused" };
  };
  await assert.rejects(superviseStagedPreservation(f.ports, f.options), /pause_overrun/);
  assert.deepEqual(f.events.slice(-2), ["restore", "cleanup"]);
  assert.equal(f.work.length, 0);
});


test("identity comparison preserves nested context bindings",async()=>{
 const f=fixture();f.binding.context={endpoint:{port:5434},pins:{source:"a".repeat(64)}};
 f.ports.verifyIdentity=async()=>({...f.binding,context:{endpoint:{port:5432},pins:{source:"a".repeat(64)}}});
 await assert.rejects(superviseStagedPreservation(f.ports,f.options),/identity_changed/);
 assert.ok(!f.events.includes("capture"));assert.equal(f.cleanups(),1);
});


test("pause full failure grace covers 170 seconds plus native internal restoration",async()=>{
 const f=fixture();f.ports.pause=async(_ctx,r)=>{assert.equal(r.timeoutMs,470000);f.advance(170000+240000+30000);throw Error("native-pause-failed-after-restore");};
 f.ports.verifyMaintenanceExit=async(_ctx,r)=>({status:"empty",nonce:r.windowNonce,challenge:r.challenge,identitySha256:r.identitySha256});
 await assert.rejects(superviseStagedPreservation(f.ports,f.options),/native-pause-failed-after-restore/);
 assert.deepEqual(f.events.slice(-2),["restore","cleanup"]);
});


test("driver and restoration reserve independent probes and cleanup before 55-minute watchdog",async()=>{
 const f=fixture(),restore=f.ports.restore;
 f.ports.restore=async(ctx,r)=>{assert.ok(r.deadlineAtMs<=r.monotonicDeadlineAtMs);assert.ok(r.timeoutMs<=240000);return restore(ctx,r);};
 const result=await superviseStagedPreservation(f.ports,f.options);assert.equal(result.parityComplete,true);
 for(const r of f.work)assert.ok(r.timeoutMs<=preservationStageMaximumMs(r.stage));
});
