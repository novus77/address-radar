import { createHash, randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const lifecyclePath = "/var/folders/fh/qqfldsc5633ds9h962zq5x2w0000gn/T/radar_rehearsal_lifecycle-qz6YDc/private-pg16-lifecycle.mjs";
export const lifecycleSha256 = "f64463042e64f2d11ccfdd078ca00c47e0610d672b02cd51379d94bc1b7a49bb";
export const maintenanceHelperPath = "/var/lib/address-radar-maintenance-tools/e049c1b56217344ccb8baa4954029666348cb8594d5016ab213ad0b292eccc0d/helper.py";
export const sourcePins = Object.freeze({ manifestSha256: "d73b0c6f794c649058072cd07ea2af6989193f5e8c705456e9d82d0e25e7350c", snapshotSha256: "d73d27350f0785ac3938024f7d56c77b5c4b404a236b75dc6ff1cb726a0e91b7", catalogFingerprint: "6f8776bbba041c4cd91cb0d622f0d169286857371099198ea0123d3bc439edf5", tables: 141, rows: 6023033, chunks: 1548 });
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const requireGate = (value, reason) => { if (!value) throw new Error("staged_preservation_" + reason); };
const canonical = value => JSON.stringify(normalize(value));
const normalize = value => Array.isArray(value) ? value.map(normalize) : value && typeof value === "object" ?
  Object.fromEntries(Object.keys(value).sort().map(key => [key, normalize(value[key])])) : value;
const same = (a, b) => canonical(a) === canonical(b);
const integer = (value, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value >= 0 && value <= max;

const expiryFields = Object.freeze(["rootOwned", "immutable", "independent", "armed", "identitySha256", "helperSha256", "expiresAtMs", "recordSha256"]);

export function preservationStageMaximumMs(stage) {
  requireGate(["calibrate", "install", "import", "parity", "freeze", "verify", "finalize"].includes(stage), "stage");
  return stage === "calibrate" || stage === "install" || stage === "freeze" ? 180000 : 900000;
}

/** Abort early enough to include transport TERM/KILL and close acknowledgement.
 * The port must settle only after its process closes; never race port lifetime
 * against restoration or release the lifecycle while a producer is still running.
 */
export async function runBoundedPreservationCall(operation, ctx, request, {
  clock = Date.now, monotonic = () => performance.now(), reason,
  schedule = setTimeout, cancel = clearTimeout,
}) {
  const beganAtMs = clock(), beganMono = monotonic();
  const durationMs = Math.floor(Math.min(request.timeoutMs, request.deadlineAtMs - beganAtMs,
    request.monotonicDeadlineAtMs - beganMono));
  requireGate(Number.isFinite(durationMs) && durationMs > 10000, reason);
  const controller = new AbortController();
  const timer = schedule(() => controller.abort(), durationMs - 10000);
  try {
    const value = await operation(ctx, { ...request, deadlineAtMs: beganAtMs + durationMs,
      monotonicDeadlineAtMs: beganMono + durationMs, timeoutMs: durationMs,
      abortAfterMs: durationMs - 10000, signal: controller.signal });
    requireGate(!controller.signal.aborted && clock() <= beganAtMs + durationMs &&
      monotonic() <= beganMono + durationMs, reason);
    return value;
  } finally { cancel(timer); }
}

/** The host adapter must enforce each deadline in its process group, await closure,
 * and return independently observed receipts. Abort alone is not a kill guarantee.
 * No adapter may detach the lifecycle callback or synthesize parity/expiry proof.
 */
export async function superviseStagedPreservation(ports, options = {}) {
  return supervisePreservationCore(ports, options);
}

/** Explicit protocol 2; the fixed host factory keeps its independent arm gate. */
export async function superviseSegmentedPreservation(ports, options = {}) {
  for (const name of ["measureDatabaseFreeze", "verifyArtifactSeal"])
    requireGate(typeof ports[name] === "function", "missing_adapter_" + name);
  return supervisePreservationCore(ports, options, createSegmentedState(options));
}

async function supervisePreservationCore(ports, { clock = Date.now, monotonic = () => performance.now(), maximumZeroProgress = 1 } = {}, segmented) {
  for (const name of ["withFixture", "bind", "verifyIdentity", "armExpiry", "verifyExpiry", "capture", "armMaintenance", "pause", "restore", "runStage", "verifyInvocationEmpty", "record"])
    requireGate(typeof ports[name] === "function", "missing_adapter_" + name);
  requireGate(integer(maximumZeroProgress, 10) && maximumZeroProgress > 0, "zero_progress_limit");
  const started = clock(), startedMono = monotonic(), absoluteDeadlineAtMs = started + 3 * 3600000;
  let expiryProof, expiryVerifiedAtMs, expiryVerifiedMono;
  const remaining = () => Math.min(absoluteDeadlineAtMs - clock(), 3 * 3600000 - (monotonic() - startedMono),
    expiryProof ? expiryProof.expiresAtMs - clock() : Infinity,
    expiryProof ? expiryProof.expiresAtMs - expiryVerifiedAtMs - (monotonic() - expiryVerifiedMono) : Infinity);
  const check = () => requireGate(remaining() > 0, "absolute_deadline");
  const sessionId = randomBytes(16).toString("hex");
  let result;
  await ports.withFixture(async ctx => {
    try {
    const binding = Object.freeze(structuredClone(await ports.bind(ctx, { sessionId, absoluteDeadlineAtMs })));
    requireGate(binding.nonce === ctx.nonce && /^[a-f0-9]{16}$/.test(binding.nonce), "nonce_binding");
    requireGate(binding.root === "/tmp/radar_rehearsal_" + ctx.nonce && binding.database === ctx.database && binding.schema === ctx.schema && binding.role === ctx.role && binding.systemIdentifier === ctx.systemIdentifier, "context_binding");
    requireGate(/^[a-f0-9]{48}$/.test(binding.owner) && integer(binding.directoryDevice) && integer(binding.directoryInode) && integer(binding.postmasterPid) && binding.postmasterPid > 0 && typeof binding.postmasterStart === "string" && binding.postmasterStart.length > 0, "owner_binding");
    for (const field of ["connectionSha256", "runnerSha256", "sourceReaderSha256", "expiryHelperSha256"]) requireGate(/^[a-f0-9]{64}$/.test(binding[field]), "code_binding");
    requireGate(binding.lifecycleSha256 === lifecycleSha256 && binding.maintenanceHelperPath === maintenanceHelperPath, "frozen_helper");
    const identitySha256 = sha(canonical(binding));
    segmented?.bind(binding, identitySha256);
    const request = () => ({ binding, identitySha256, sourcePins, sessionId, absoluteDeadlineAtMs, deadlineAtMs: clock() + remaining(), monotonicDeadlineAtMs: monotonic() + remaining() });
    const identity = async () => { check(); requireGate(same(await ports.verifyIdentity(ctx, request()), binding), "identity_changed"); };
    const verifyExpiry = async () => {
      check();
      const proof = await ports.verifyExpiry(ctx, request());
      requireGate(proof !== null && typeof proof === "object" && !Array.isArray(proof) && Object.keys(proof).length === expiryFields.length && expiryFields.every(key => Object.hasOwn(proof, key)), "expiry_fields");
      requireGate(proof.rootOwned === true && proof.immutable === true && proof.independent === true && proof.armed === true && proof.identitySha256 === identitySha256 && proof.helperSha256 === binding.expiryHelperSha256 && integer(proof.expiresAtMs) && proof.expiresAtMs <= absoluteDeadlineAtMs && proof.expiresAtMs > clock() && /^[a-f0-9]{64}$/.test(proof.recordSha256), "expiry_unverified");
      if (expiryProof) requireGate(same(proof, expiryProof), "expiry_identity_changed");
      else { expiryProof = Object.freeze(structuredClone(proof)); expiryVerifiedAtMs = clock(); expiryVerifiedMono = monotonic(); }
      return proof;
    };
    await identity();
    await ports.armExpiry(ctx, request());
    await verifyExpiry();
    let stage = "calibrate", windowIndex = 0, invocationIndex = 0, durableChunks = 0, zeroProgress = 0;
    let acknowledgedCommits = 0, commitAttempts = 0, physicalSqlStatements = 0;
    const nonces = new Set();
    while (!result) {
      await identity(); await verifyExpiry();
      const windowNonce = randomBytes(8).toString("hex");
      requireGate(/^[a-f0-9]{16}$/.test(windowNonce), "window_nonce");
      requireGate(!nonces.has(windowNonce), "window_nonce_reused"); nonces.add(windowNonce);
      const capturedAt = clock(), capturedMono = monotonic();
      const window = { ...request(), windowNonce, windowIndex: ++windowIndex, maintenanceHelperPath,
        expiresAtMs: expiryProof.expiresAtMs, expiryRecordSha256: expiryProof.recordSha256,
        deadlineAtMs: Math.min(capturedAt + remaining() - 240000 - 40000, capturedAt + 55 * 60000 - 240000 - 40000 - 60000),
        monotonicDeadlineAtMs: capturedMono + Math.min(remaining() - 240000 - 40000, 55 * 60000 - 240000 - 40000 - 60000) };
      requireGate(remaining() >= 55 * 60000 + 240000 + 40000 + 60000 && window.deadlineAtMs > capturedAt + 70000, "window_budget");
      const windowInvocations = []; let pauseAttempted = false;
      // Capture failures still invoke restoration: capture may have persisted before transport failed.
      try {
        const baseline = await ports.capture(ctx, window);
        requireGate(baseline.nonce === windowNonce && /^[a-f0-9]{64}$/.test(baseline.baselineSha256), "baseline_binding");
        window.baselineSha256 = baseline.baselineSha256;
        const armed = await ports.armMaintenance(ctx, { ...window, watchdogMs: 55 * 60000, restoreTimeoutMs: 240000 });
        requireGate(armed.verified === true && armed.nonce === windowNonce && armed.baselineSha256 === baseline.baselineSha256 && armed.watchdogMs === 55 * 60000 && armed.restoreTimeoutMs === 240000, "maintenance_watchdog");
        requireGate(clock() - capturedAt < 60000 && monotonic() - capturedMono < 60000, "capture_stale");
        const pauseClock = clock(), pauseMono = monotonic();
        const pauseDurationMs = Math.floor(Math.min(470000, capturedAt + 55 * 60000 - pauseClock - 240000 - 40000,
          capturedMono + 55 * 60000 - pauseMono - 240000 - 40000, window.deadlineAtMs - pauseClock,
          window.monotonicDeadlineAtMs - pauseMono, remaining() - 240000 - 40000));
        requireGate(pauseDurationMs >= 465000, "pause_budget");
        const pauseRequest = { ...window, deadlineAtMs: pauseClock + pauseDurationMs,
          monotonicDeadlineAtMs: pauseMono + pauseDurationMs, timeoutMs: pauseDurationMs };
        pauseAttempted = true;
        requireGate((await runBoundedPreservationCall(ports.pause, ctx, pauseRequest,
          { clock, monotonic, reason: "pause_overrun" })).phase === "paused", "pause_unverified");
        while (!result && clock() + 70000 < window.deadlineAtMs && monotonic() + 70000 < window.monotonicDeadlineAtMs) {
          await identity(); await verifyExpiry();
          const invocationId = sessionId + "-" + String(++invocationIndex).padStart(6, "0");
          const maximumStageMs = preservationStageMaximumMs(stage);
          const workStarted = monotonic(), workClock = clock();
          const stageDurationMs = Math.floor(Math.min(maximumStageMs, window.deadlineAtMs - workClock,
            window.monotonicDeadlineAtMs - workStarted, remaining() - 240000 - 40000));
          requireGate(stageDurationMs > 70000, "stage_budget");
          const deadlineAtMs = workClock + stageDurationMs;
          const work = { ...window, ...(segmented ? segmented.work(stage) : {}), stage, invocationId, deadlineAtMs,
            monotonicDeadlineAtMs: workStarted + stageDurationMs, timeoutMs: stageDurationMs, maximumTransactionMs: 60000, closeReserveMs: 10000,
            environment: { PRESERVATION_INVOCATION_ID: invocationId }, configName: invocationId + "-config.json", authorityName: invocationId + "-authority.json", outputName: invocationId + "-stdout.json", evidenceName: stage + "-" + invocationId + ".json",
            ...(segmented && ["verify", "finalize"].includes(stage) ? { evidenceDirectory: binding.receiptDirectory } : {}),
            resources: { maximumRssBytes: 256 * 1024 ** 2, minimumAvailableMemoryBytes: 1024 ** 3, reserveBytes: 5 * 1024 ** 3, maximumMemoryPsiAvg10: 1 },
            freshSourceValidationRequired: true, durableBodyReconciliationRequired: true };
          if (!segmented || work.stage !== "freeze") windowInvocations.push(invocationId);
          const receipt = await runBoundedPreservationCall(segmented ? (ctx, request) => segmented.execute(ports, ctx, request) : ports.runStage, ctx, work, { clock, monotonic, reason: "stage_overrun" });
          requireGate(clock() <= deadlineAtMs && monotonic() - workStarted <= stageDurationMs, "stage_overrun");
          requireGate(receipt.invocationId === invocationId && receipt.exitCode === 0 && !receipt.reason && same(receipt.sourcePins, sourcePins) && receipt.identitySha256 === identitySha256, "stage_failed_reconcile_before_retry");
          const report = receipt.report, native = report?.nativeMetrics;
          requireGate(native && [native.commitAttempts, native.acknowledgedCommits, native.physicalSqlStatements].every(x => integer(x)) && native.commitAttempts === native.acknowledgedCommits && !report.failure?.commitUncertaintyObserved, "commit_unknown_reconcile_before_retry");
          acknowledgedCommits += native.acknowledgedCommits; commitAttempts += native.commitAttempts; physicalSqlStatements += native.physicalSqlStatements;
          if (segmented) {
            const next = segmented.accept(stage, receipt, work);
            stage = next.stage; durableChunks = next.durableChunks;
            if (next.completed) result = { status: "completed", protocolVersion: 2, parityComplete: true,
              sourcePins, identitySha256, windowIndex, invocationIndex, durableChunks,
              acknowledgedCommits, commitAttempts, physicalSqlStatements,
              coverageSha256: next.coverageSha256, verifiedSegments: next.verifiedSegments,
              productionAuthorized: false };
          } else if (stage === "calibrate") {
            requireGate(report.status === "calibrated" && report.rollbackObserved === true && native.acknowledgedRollbacks >= 1, "calibration_failed"); stage = "import";
          } else if (stage === "import") {
            requireGate(report.parityComplete === false && receipt.freshSourceValidationComplete === true && receipt.durableBodyReconciliationComplete === true, "import_proof");
            requireGate(["yielded_before_transaction", "import_completed_pending_parity"].includes(report.status), "import_status");
            requireGate(integer(receipt.durableChunks, sourcePins.chunks) && receipt.durableChunks >= durableChunks, "durable_accounting");
            zeroProgress = receipt.durableChunks === durableChunks ? zeroProgress + 1 : 0; durableChunks = receipt.durableChunks;
            requireGate(zeroProgress < maximumZeroProgress, "zero_progress");
            if (report.status === "import_completed_pending_parity") { requireGate(durableChunks === sourcePins.chunks, "incomplete_import"); stage = "parity"; }
          } else {
            requireGate(report.status === "completed" && report.parityComplete === true && receipt.freshSourceValidationComplete === true && same(receipt.parityCounts, { tables: sourcePins.tables, rows: sourcePins.rows, chunks: sourcePins.chunks }), "parity_incomplete");
            result = { status: "completed", parityComplete: true, sourcePins, identitySha256, windowIndex, invocationIndex, durableChunks, acknowledgedCommits, commitAttempts, physicalSqlStatements, productionAuthorized: false };
          }
          // Deliberately write only an allowlisted receipt; neither credentials nor raw output escapes.
          await ports.record({ ...(segmented ? { protocolVersion: 2, evidenceDirectory: work.evidenceDirectory, coverageSha256: segmented.coverageSha256 } : {}), sessionId, invocationId, stage: work.stage, status: report.status, sourcePins, identitySha256, durableChunks, acknowledgedCommits, commitAttempts, physicalSqlStatements, parityComplete: result?.parityComplete ?? false, productionAuthorized: false });
        }
      } finally {
        if (pauseAttempted && ports.verifyMaintenanceExit) {
          try {
            const challenge = randomBytes(16).toString("hex"), began = clock(), mono = monotonic();
            const duration = Math.floor(Math.min(30000, remaining() - 240000 - 40000,
              capturedMono + 55 * 60000 - mono));
            const proof = await runBoundedPreservationCall(ports.verifyMaintenanceExit, ctx,
              { ...window, challenge, deadlineAtMs: began + duration, monotonicDeadlineAtMs: mono + duration, timeoutMs: duration },
              { clock, monotonic, reason: "maintenance_exit_unproven" });
            requireGate(proof?.status === "empty" && proof.nonce === windowNonce &&
              proof.challenge === challenge && proof.identitySha256 === identitySha256, "maintenance_exit_unproven");
          } catch {
            await ports.record({ sessionId, windowNonce, status: "watchdog_handoff_maintenance_exit_unproven", parityComplete: false, productionAuthorized: false });
            throw new Error("staged_preservation_watchdog_handoff_maintenance_exit_unproven");
          }
        }
        if (windowInvocations.length) {
          try {
            const challenge = randomBytes(16).toString("hex"), probeClock = clock(), probeMono = monotonic();
            const budget = Math.floor(Math.min(30000, remaining() - 240000 - 40000,
              capturedMono + 55 * 60000 - probeMono));
            const proof = await runBoundedPreservationCall(ports.verifyInvocationEmpty, ctx, { ...window,
              invocationIds: [...windowInvocations], challenge, deadlineAtMs: probeClock + budget,
              monotonicDeadlineAtMs: probeMono + budget, timeoutMs: budget },
            { clock, monotonic, reason: "producer_exit_unproven" });
            requireGate(proof?.challenge === challenge && proof.identitySha256 === identitySha256 &&
              Array.isArray(proof.proofs) && proof.proofs.length === windowInvocations.length,
              "producer_exit_unproven");
            for (let index = 0; index < windowInvocations.length; index++) {
              const item = proof.proofs[index], id = windowInvocations[index];
              requireGate(item?.invocationId === id && (!ports.managedRetirementProtocol || item.managedProtocol === ports.managedRetirementProtocol) && (item.managedProtocol === 1 && segmented ?
                /^[a-f0-9]{16}$/.test(item.requestNonce) && ["producer","verifier","finalizer"].includes(item.role) &&
                item.unit === "radar-rehearsal-"+ctx.nonce+"-"+item.role+"-"+item.requestNonce+".service" &&
                /^[a-f0-9]{32}$/.test(item.nativeInvocationId) && item.nativeInvocationId !== "0".repeat(32) &&
                Array.isArray(item.cgroupIdentity) && item.cgroupIdentity.length===2 && item.cgroupIdentity.every(x=>integer(x)) &&
                typeof item.controlGroup === "string" && item.controlGroup.startsWith("/") && item.controlGroup!=="/" :
                item.unit === "address-radar-preservation-invocation-" + ctx.nonce + "-" + id + ".service") &&
                /^[a-f0-9]{64}$/.test(item.recordSha256) && /^[a-f0-9]{64}$/.test(item.instanceSha256) &&
                item.cgroupPopulated === 0 && item.cgroupProcessCount === 0,
                "producer_exit_unproven");
            }
          } catch {
            await ports.record({ sessionId, windowNonce, status: "watchdog_handoff_producer_exit_unproven",
              invocationIds: [...windowInvocations], parityComplete: false, productionAuthorized: false });
            throw new Error("staged_preservation_watchdog_handoff_producer_exit_unproven");
          }
        }
        const restoreStarted = monotonic(), restoreClock = clock();
        const restoreDurationMs = Math.floor(Math.min(240000, remaining() - 40000,
          capturedMono + 55 * 60000 - 40000 - restoreStarted, capturedAt + 55 * 60000 - 40000 - restoreClock));
        const restored = await runBoundedPreservationCall(ports.restore, ctx, { ...window,
          deadlineAtMs: restoreClock + restoreDurationMs, monotonicDeadlineAtMs: restoreStarted + restoreDurationMs,
          timeoutMs: restoreDurationMs, restoreTimeoutMs: Math.min(240000, restoreDurationMs) },
        { clock, monotonic, reason: "restore_unconfirmed" });
        requireGate(restored.status === "restored" && restored.nonce === windowNonce && monotonic() - restoreStarted <= restoreDurationMs, "restore_unconfirmed");
        requireGate(monotonic() - capturedMono <= 60 * 60000 && clock() - capturedAt <= 60 * 60000, "window_overrun");
      }
      if (!result) { await identity(); await verifyExpiry(); }
    }
    } finally {
      try { if (ports.closeRetained) await ports.closeRetained(ctx); }
      finally { if (ports.finalCleanup) await ports.finalCleanup(ctx); }
    }
  });
  return { ...result, lifecycleCleanupConfirmed: true };
}

function createSegmentedState({ clock = Date.now } = {}) {
  const isHash = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
  let binding, identitySha256, durableChunks = 0, durableRows = 0, sealSha256, freezeSha256;
  let sealIdentity, freezeIdentity, verifiedChunks = 0, verifiedRows = 0, coverageSha256;
  const segments = [], measurementIds = new Set();
  const immutableSeal = proof => ({ sealSha256: proof.sealSha256, identitySha256: proof.identitySha256,
    artifactRoot: proof.artifactRoot, artifactOwner: proof.artifactOwner,
    artifactDevice: proof.artifactDevice, artifactInode: proof.artifactInode,
    artifactControlRoot: proof.artifactControlRoot, artifactControlDevice: proof.artifactControlDevice,
    artifactControlInode: proof.artifactControlInode, artifactLockDevice: proof.artifactLockDevice,
    artifactLockInode: proof.artifactLockInode, receiptDirectory: proof.receiptDirectory,
    receiptDirectoryDevice: proof.receiptDirectoryDevice, receiptDirectoryInode: proof.receiptDirectoryInode });
  const liveSeal = async (ports, ctx, work) => {
    const challenge = randomBytes(16).toString("hex");
    const proof = await ports.verifyArtifactSeal(ctx, { ...work, challenge, sealSha256 });
    requireGate(proof?.challenge === challenge && proof.status === "sealed" && proof.identitySha256 === identitySha256 &&
      proof.sealSha256 === sealSha256 && proof.receiptDirectoryUid === 0, "artifact_seal_unverified");
    for (const key of ["artifactRoot", "artifactOwner", "artifactDevice", "artifactInode", "artifactControlRoot",
      "artifactControlDevice", "artifactControlInode", "artifactLockDevice", "artifactLockInode",
      "receiptDirectory", "receiptDirectoryDevice", "receiptDirectoryInode"])
      requireGate(proof[key] === binding[key], "artifact_seal_binding");
    const stable = immutableSeal(proof);
    if (sealIdentity) requireGate(same(stable, sealIdentity), "artifact_seal_changed");
    else sealIdentity = Object.freeze(stable);
  };
  const liveDatabaseFreeze = async (ports, ctx, work) => {
    const challenge = randomBytes(16).toString("hex"), beganAtMs = clock();
    const proof = await ports.measureDatabaseFreeze(ctx, { ...work, challenge, freezeSha256 });
    requireGate(proof?.challenge === challenge && proof.identitySha256 === identitySha256 && proof.freezeSha256 === freezeSha256 &&
      isHash(proof.measurementSha256) && !measurementIds.has(proof.measurementSha256) &&
      integer(proof.measuredAtMs) && proof.measuredAtMs >= beganAtMs && proof.measuredAtMs <= clock() &&
      integer(proof.nativeMeasurementQueries) && proof.nativeMeasurementQueries > 0 &&
      proof.writerSessionCount === 0 && proof.writeAuthorityCount === 0 &&
      isHash(proof.mutationEpochSha256) && proof.systemIdentifier === binding.systemIdentifier,
      "database_freeze_unverified");
    measurementIds.add(proof.measurementSha256);
    const stable = { identitySha256, freezeSha256, mutationEpochSha256: proof.mutationEpochSha256,
      systemIdentifier: proof.systemIdentifier, writerSessionCount: proof.writerSessionCount,
      writeAuthorityCount: proof.writeAuthorityCount };
    if (freezeIdentity) requireGate(same(stable, freezeIdentity), "database_freeze_changed");
    else freezeIdentity = Object.freeze(stable);
  };
  const attest = async (ports, ctx, work) => { await liveSeal(ports, ctx, work); await liveDatabaseFreeze(ports, ctx, work); };
  const validateEnvelope = (receipt, work) => {
    requireGate(receipt.protocolVersion === 2 && receipt.report?.protocolVersion === 2 && receipt.report.stage === work.stage &&
      receipt.runnerSha256 === binding.runnerSha256 && isHash(receipt.reportSha256) &&
      receipt.report.productionAuthorized === false, "segmented_native_receipt");
    requireGate(work.stage === "finalize" || receipt.report.parityComplete === false, "premature_completion");
  };
  const fullCoverage = () => verifiedChunks === sourcePins.chunks && verifiedRows === sourcePins.rows && segments.length > 0;
  const coverageDigest = () => sha(JSON.stringify({ protocolVersion: 2, identitySha256, sourcePins,
    sealSha256, freezeSha256, segments }));
  return {
    bind(value, identity) {
      binding = value; identitySha256 = identity;
      requireGate(binding.artifactRoot === "/var/lib/address-radar-rehearsal-artifacts/" + binding.nonce &&
        binding.artifactControlRoot === "/var/lib/address-radar-rehearsal-artifact-control/" + binding.nonce &&
        binding.receiptDirectory === binding.artifactControlRoot + "/receipts" &&
        /^[a-f0-9]{48}$/.test(binding.artifactOwner), "segmented_artifact_namespace");
      for (const field of ["artifactDevice", "artifactInode", "artifactControlDevice", "artifactControlInode",
        "artifactLockDevice", "artifactLockInode", "receiptDirectoryDevice", "receiptDirectoryInode"])
        requireGate(integer(binding[field]), "segmented_artifact_identity");
    },
    work(stage) {
      return { protocolVersion: 2, ...(stage === "import" ? { importStartChunk: durableChunks } : {}),
        ...(stage === "verify" ? { verifyStartChunk: verifiedChunks } : {}),
        ...(["verify", "finalize"].includes(stage) ? { sealSha256, freezeSha256, coverageSha256,
          coverage: segments.map(segment => ({ ...segment })) } : {}) };
    },
    async execute(ports, ctx, work) {
      if (["verify", "finalize"].includes(work.stage)) {
        requireGate(work.evidenceDirectory === binding.receiptDirectory, "sealed_evidence_namespace");
        await attest(ports, ctx, work);
        try { return await ports.runStage(ctx, work); }
        finally { await attest(ports, ctx, work); }
      }
      const receipt = await ports.runStage(ctx, work);
      if (work.stage === "freeze") {
        validateEnvelope(receipt, work);
        requireGate(receipt.report.status === "frozen_pending_verification" && isHash(receipt.report.sealSha256) &&
          isHash(receipt.report.freezeSha256) && receipt.report.sealSha256 !== receipt.report.freezeSha256,
          "freeze_receipt");
        sealSha256 = receipt.report.sealSha256; freezeSha256 = receipt.report.freezeSha256;
        await attest(ports, ctx, work);
      }
      return receipt;
    },
    accept(stage, receipt, work) {
      validateEnvelope(receipt, work);
      const report = receipt.report;
      if (stage === "calibrate") {
        requireGate(report.status === "calibrated" && report.rollbackObserved === true &&
          report.nativeMetrics.acknowledgedRollbacks >= 1, "calibration_failed");
        return { stage: "import", durableChunks };
      }
      if (stage === "import") {
        requireGate(["import_segment_committed", "import_segments_exhausted"].includes(report.status) &&
          receipt.freshSourceValidationComplete === true && receipt.durableBodyReconciliationComplete === true,
          "segmented_import_receipt");
        const segment = report.segment;
        requireGate(segment && segment.startChunk === durableChunks && integer(segment.endChunk, sourcePins.chunks) &&
          segment.endChunk > segment.startChunk && integer(segment.rows, sourcePins.rows) &&
          receipt.durableChunks === segment.endChunk && isHash(segment.sourceSha256) &&
          report.nativeMetrics.acknowledgedCommits > 0, "segmented_import_progress");
        durableChunks = segment.endChunk; durableRows += segment.rows;
        requireGate(durableRows <= sourcePins.rows, "segmented_import_rows");
        if (report.status === "import_segments_exhausted") {
          requireGate(durableChunks === sourcePins.chunks && durableRows === sourcePins.rows, "segmented_import_incomplete");
          return { stage: "freeze", durableChunks };
        }
        requireGate(durableChunks < sourcePins.chunks, "segmented_import_exhaustion_missing");
        return { stage: "import", durableChunks };
      }
      if (stage === "freeze") return { stage: "verify", durableChunks };
      requireGate(report.sealSha256 === sealSha256 && report.freezeSha256 === freezeSha256, "verification_binding");
      if (stage === "verify") {
        requireGate(report.status === "segment_verified_pending_finalization" && receipt.freshSourceValidationComplete === true,
          "segmented_verify_receipt");
        const segment = report.segment;
        requireGate(segment && segment.startChunk === verifiedChunks && integer(segment.endChunk, sourcePins.chunks) &&
          segment.endChunk > segment.startChunk && integer(segment.rows, sourcePins.rows) &&
          isHash(segment.sourceSha256) && segment.sourceSha256 === segment.targetSha256 &&
          report.nativeMetrics.physicalSqlStatements > 0, "verification_coverage");
        segments.push(Object.freeze({ startChunk: segment.startChunk, endChunk: segment.endChunk,
          rows: segment.rows, sourceSha256: segment.sourceSha256, targetSha256: segment.targetSha256 }));
        verifiedChunks = segment.endChunk; verifiedRows += segment.rows;
        requireGate(verifiedRows <= sourcePins.rows, "verification_rows");
        if (verifiedChunks === sourcePins.chunks) {
          requireGate(fullCoverage(), "verification_incomplete"); coverageSha256 = coverageDigest();
          return { stage: "finalize", durableChunks };
        }
        return { stage: "verify", durableChunks };
      }
      requireGate(stage === "finalize" && fullCoverage() && coverageSha256 === coverageDigest() &&
        report.status === "finalized" && report.parityComplete === true && report.coverageSha256 === coverageSha256 &&
        same(report.counts, { tables: sourcePins.tables, rows: sourcePins.rows, chunks: sourcePins.chunks }) &&
        report.nativeMetrics.finalizeAttempts === 1 && report.nativeMetrics.acknowledgedFinalizations === 1 &&
        report.nativeMetrics.acknowledgedCommits > 0, "finalization_unacknowledged_or_incomplete");
      return { stage: "finalize", durableChunks, completed: true, coverageSha256, verifiedSegments: segments.length };
    },
    get coverageSha256() { return coverageSha256; },
  };
}

export async function runPinnedStagedPreservation(adapterPath, adapterSha256) {
  requireGate(/^[a-f0-9]{64}$/.test(adapterSha256 ?? ""), "adapter_pin_required");
  requireGate(sha(await readFile(adapterPath)) === adapterSha256, "adapter_pin");
  requireGate(sha(await readFile(lifecyclePath)) === lifecycleSha256, "lifecycle_pin");
  const { createStagedPreservationPorts } = await import(pathToFileURL(resolve(adapterPath)).href);
  requireGate(typeof createStagedPreservationPorts === "function", "adapter_factory");
  const { withPrivatePreservationFixture } = await import(pathToFileURL(lifecyclePath).href);
  const ports = await createStagedPreservationPorts({ sourcePins, maintenanceHelperPath });
  requireGate(!Object.hasOwn(ports, "withFixture"), "adapter_lifecycle_override");
  requireGate(ports.protocolVersion === undefined || ports.protocolVersion === 2,"adapter_protocol");
  return (ports.protocolVersion === 2 ? superviseSegmentedPreservation : superviseStagedPreservation)({ ...ports, withFixture: withPrivatePreservationFixture });
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  try {
    const [adapterPath, adapterPin, evidencePath] = process.argv.slice(2);
    requireGate(process.argv.length === 5 && evidencePath, "arguments");
    const result = await runPinnedStagedPreservation(adapterPath, adapterPin);
    await writeFile(evidencePath, JSON.stringify(result) + "\n", { flag: "wx", mode: 0o600 });
    process.stdout.write(JSON.stringify(result) + "\n");
  } catch {
    process.stdout.write(JSON.stringify({ status: "failed", reconciliationRequired: true, parityComplete: false, lifecycleCleanupConfirmed: false, productionAuthorized: false }) + "\n");
    process.exitCode = 1;
  }
}
