import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createFixedTransport, sshArgs, remotePython, buildHostAdapter, authenticateInvocationEmptyProof, authenticateStageReceipt } from "../staged-postgres-preservation-host-adapter.mjs";
import { sourcePins } from "../run-staged-postgres-preservation-fixture.mjs";
const hash = x => createHash("sha256").update(x).digest("hex");
const h = "c".repeat(64);
function transportChild() {
  const child = new EventEmitter(); child.pid = 2147483647;
  child.stdout = new PassThrough(); child.stdin = new PassThrough(); child.kill = signal => { child.signals.push(signal); return true; }; child.signals = []; return child;
}
test("fixed SSH target, argv and encoded stdin; successful transport waits for close", async () => {
  const child = transportChild(); let invocation;
  const transport = createFixedTransport((...args) => { invocation = args; queueMicrotask(() => { child.stdout.write('{"ok":true,"value":{"x":1}}'); child.emit("close", 0); }); return child; });
  assert.deepEqual(await transport({ action: "identity", hostile: "$(touch /tmp/never)" }, 1000), { x: 1 });
  assert.equal(invocation[0], "ssh"); assert.deepEqual(invocation[1], [...sshArgs]); assert.equal(invocation[2].detached, true);
});
test("timeout escalates process termination and rejects only after close", async () => {
  const child = transportChild(); child.kill = signal => { child.signals.push(signal); if (signal === "SIGKILL") queueMicrotask(() => child.emit("close", null)); return true; };
  const transport = createFixedTransport(() => child, { graceMs: 2 });
  await assert.rejects(transport({}, 5), /transport_timeout/); assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
});
test("malformed, failed and excessive transport output are refused without disclosure", async () => {
  for (const output of ['{"ok":false,"secret":"credential"}', "garbage", "x".repeat(1024 * 1024 + 1)]) {
    const child = transportChild();
    const transport = createFixedTransport(() => { queueMicrotask(() => { child.stdout.write(output); child.emit("close", 0); }); return child; });
    await assert.rejects(transport({}, 1000), error => !error.message.includes("credential"));
  }
});
test("remote program compiles locally without host operations", () => {
  const result = spawnSync("python3", ["-c", "import sys; compile(sys.stdin.read(), '<fixed-adapter>', 'exec')"], { input: remotePython, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!remotePython.includes("os.killpg("));
  assert.ok(remotePython.includes("cgroup.events"));
  assert.ok(remotePython.includes("RuntimeMaxSec="));
  assert.ok(remotePython.includes("invocation_empty(child,True)"));
  assert.ok(remotePython.includes("finally:\n stop_child()"));
  assert.ok(remotePython.includes("timer_verify"));
});
function receipt(stage = "import") {
  const work = { stage, invocationId: "a".repeat(32) + "-000001", identitySha256: h };
  const state = { target: { database: "fixture" }, runnerSha256: h, sourceReaderSha256: h, configSha256: h, authoritySha256: h };
  const report = { stage, status: stage === "import" ? "yielded_before_transaction" : "completed", expected: sourcePins, target: state.target,
    productionAuthorized: false, sourceWrites: false, businessActivation: false, grantsBusinessEligibility: false, parityComplete: stage === "parity", previouslyCommittedChunks: 10,
    nativeMetrics: { physicalSqlStatements: 100, commitAttempts: 2, acknowledgedCommits: 2, acknowledgedRollbacks: 0 }, sourceReader: { freshHash: true, cachedWitnessUsed: false, files: 1549 },
    progress: { previouslyCommittedChunks: 10, newlyCommittedChunks: 2, resumedChunks: 10, newlyCommittedRows: 20, parityChunks: 0, sourceVerifiedAtMs: 1, parityRows: 0 } };
  const value = { ...state, ...work, expected: sourcePins, report, reportSha256: h, exitCode: 0, reason: null, elapsedMs: 1000, externalPeakRssBytes: 1, minimumAvailableMemoryBytes: 1024 ** 3, minimumFreeBytes: 5 * 1024 ** 3, maximumMemoryPsiAvg10: 0 };
  return { work, state, value };
}
test("durable cumulative count comes from prior native query plus acknowledged new chunks", () => {
  const f = receipt(), r = authenticateStageReceipt(f.value, f.work, f.state);
  assert.equal(r.durableChunks, 12); assert.equal(r.durableBodyReconciliationComplete, true); assert.equal(r.parityCounts, undefined);
});
test("unvisited durable prefix is explicitly unreconciled", () => {
  const f = receipt(); f.value.report.progress.resumedChunks = 9;
  assert.equal(authenticateStageReceipt(f.value, f.work, f.state).durableBodyReconciliationComplete, false);
});
for (const change of [r => { r.runnerSha256 = "d".repeat(64); }, r => { r.report.nativeMetrics.acknowledgedCommits--; }, r => { r.report.sourceReader.files = 1548; }, r => { r.maximumMemoryPsiAvg10 = 1.1; }, r => { r.report.progress.newlyCommittedChunks = 1549; }, r => { r.report.parityComplete = true; }, r => { r.elapsedMs = 900001; }]) test("rejects invalid native lineage, resources or accounting " + String(change), () => {
  const f = receipt(); change(f.value); assert.throws(() => authenticateStageReceipt(f.value, f.work, f.state), /preservation_host_/);
});
test("full parity requires actual all-chunk and all-row totals", () => {
  const f = receipt("parity");
  Object.assign(f.value.report.progress, { newlyCommittedChunks: 0, newlyCommittedRows: 0, parityChunks: 1548, parityRows: 6023033 });
  f.value.report.typedBytes = { rows: 6023033, chunks: 1548 };
  const r = authenticateStageReceipt(f.value, f.work, f.state); assert.deepEqual(r.parityCounts, { tables: 141, rows: 6023033, chunks: 1548 });
  f.value.report.typedBytes.rows--; assert.throws(() => authenticateStageReceipt(f.value, f.work, f.state), /parity_receipt/);
});
function mockAdapter() {
  const nonce = "a".repeat(16), db = "radar_rehearsal_" + nonce;
  const ctx = { nonce, database: db, schema: db + "_schema", role: db + "_migrator", systemIdentifier: "123", connectionPath: "/test/connection.json" };
  const conn = Buffer.from(JSON.stringify({ nonce, database: db, schema: ctx.schema, username: ctx.role, systemIdentifier: "123", host: "127.0.0.1", port: 5434, password: "d".repeat(64) }));
  const calls = [], files = { runner: Buffer.from("runner"), sourceReader: Buffer.from("reader"), expiry: Buffer.from("expiry") };
  const transport = async (p, timeout) => {
    calls.push({ p, timeout });
    if (p.action === "identity" || p.action === "bind") return { artifactRoot: "/var/lib/address-radar-rehearsal-artifacts/" + ctx.nonce, artifactOwner: "f".repeat(48), artifactDevice: 1, artifactInode: 5, owner: "b".repeat(48), connectionSha256: hash(conn), directoryDevice: 1, directoryInode: 2, dataDevice: 1, dataInode: 3, postmasterPid: 4, postmasterStart: "100", postmasterEpoch: 1 };
    if (p.action === "capture") throw new Error("uncertain_capture");
    if (p.action === "restore") return { status: "restored" };
    throw new Error("unexpected_action");
  };
  const adapter = buildHostAdapter(files, { transport, readConnection: async () => conn, fingerprint: () => ({ status: 0, stdout: h }), clock: () => 1000000 });
  return { adapter, ctx, calls };
}
test("uncertain capture restores exact native nonce without guessing or retrying capture", async () => {
  const f = mockAdapter(); await f.adapter.bind(f.ctx);
  const request = { sessionId: "f".repeat(32), windowIndex: 1, identitySha256: h, windowNonce: "e".repeat(16), deadlineAtMs: 1300000 };
  await assert.rejects(f.adapter.capture(f.ctx, request), /uncertain_capture/);
  await assert.rejects(f.adapter.capture(f.ctx, request), /capture_retry_forbidden/);
  const r = await f.adapter.restore(f.ctx, request); assert.equal(r.status, "restored");
  const capture = f.calls.find(x => x.p.action === "capture"), restore = f.calls.find(x => x.p.action === "restore");
  assert.equal(capture.p.maintenanceNonce, restore.p.maintenanceNonce); assert.equal(restore.p.baselineSha256, undefined);
  assert.ok(restore.timeout <= 240000); await assert.rejects(f.adapter.restore(f.ctx, request), /restore_retry_forbidden/);
});
test("stage cannot run before pause and independent expiry", async () => {
  const f = mockAdapter(); await f.adapter.bind(f.ctx);
  await assert.rejects(f.adapter.runStage(f.ctx, { windowNonce: "e".repeat(16) }), /stage_window/);
});

test("maintenance rejects non-native 32-hex nonce", async () => {
  const f = mockAdapter(); await f.adapter.bind(f.ctx);
  await assert.rejects(f.adapter.capture(f.ctx, { windowNonce: "e".repeat(32), deadlineAtMs: 1300000 }), /window_nonce/);
  assert.ok(!f.calls.some(x => x.p.action === "capture"));
});

test("artifact namespace is outside the PG fixture and bound by exact marker/devino", async () => {
  const f = mockAdapter(), binding = await f.adapter.bind(f.ctx);
  assert.equal(binding.artifactRoot, "/var/lib/address-radar-rehearsal-artifacts/" + f.ctx.nonce);
  assert.equal(binding.artifactOwner, "f".repeat(48));
  assert.equal(binding.artifactDevice, 1); assert.equal(binding.artifactInode, 5);
  assert.ok(!binding.artifactRoot.startsWith(binding.root + "/"));
});
test("PG-only expiry refuses retention until exact artifact cleanup protocol is approved", async () => {
  const f = mockAdapter(); await f.adapter.bind(f.ctx);
  await assert.rejects(f.adapter.armExpiry(f.ctx, { absoluteDeadlineAtMs: 10000000, deadlineAtMs: 10000000 }), /expiry_artifact_protocol_pending/);
  assert.ok(!f.calls.some(x => x.p.action === "expiry-arm"));
});

test("transport consumes AbortSignal, terminates group and waits for close", async () => {
  const child = transportChild(), controller = new AbortController(); let closed = false;
  child.kill = kind => { child.signals.push(kind); if (kind === "SIGKILL") queueMicrotask(() => { closed = true; child.emit("close", null); }); return true; };
  const transport = createFixedTransport(() => child, { graceMs: 2 });
  const pending = transport({}, 1000, { signal: controller.signal }); controller.abort();
  await assert.rejects(pending, /transport_aborted/);
  assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]); assert.equal(closed, true);
});
test("already-aborted request cannot spawn transport", async () => {
  const controller = new AbortController(); controller.abort(); let spawned = false;
  const transport = createFixedTransport(() => { spawned = true; return transportChild(); });
  await assert.rejects(transport({}, 1000, { signal: controller.signal }), /transport_aborted/);
  assert.equal(spawned, false);
});

test("independent protected invocation empty proof binds exact unit and instance", () => {
 const request={nonce:"a".repeat(16),identitySha256:h,invocationIds:["b".repeat(32)+"-000001"],challenge:"c".repeat(32)};
 const item={invocationId:request.invocationIds[0],unit:"address-radar-preservation-invocation-"+request.nonce+"-"+request.invocationIds[0]+".service",recordSha256:h,instanceSha256:h,cgroupPopulated:0,cgroupProcessCount:0};
 const proof={challenge:request.challenge,identitySha256:h,proofs:[item]};
 assert.equal(authenticateInvocationEmptyProof(proof,request),proof);
 for(const field of ["cgroupPopulated","cgroupProcessCount","unit","instanceSha256"]){
  const bad=structuredClone(proof);bad.proofs[0][field]=field==="unit"?"unrelated.service":field==="instanceSha256"?"invalid":1;
  assert.throws(()=>authenticateInvocationEmptyProof(bad,request),/producer_exit_unproven/);
 }
 assert.throws(()=>authenticateInvocationEmptyProof({challenge:request.challenge,identitySha256:h,proofs:[]},request),/producer_exit_unproven/);
});
test("remote cgroup implementation has no reaped PID/PGID signal fallback",()=>{
 assert.ok(!remotePython.includes("child.poll()"));
 assert.ok(!remotePython.includes("os.killpg("));
 assert.ok(remotePython.includes("s['ExecMainStartTimestampMonotonic']==instance['startMonotonicUs']"));
 assert.ok(remotePython.includes("[info.st_dev,info.st_ino]==instance['cgroupIdentity']"));
});


test("valid remote refusal is distinct from corrupted JSON and never exposes arbitrary errors",async()=>{
 for(const [output,reason] of [
  ['{"ok":false,"reason":"fixed-operation-refused"}','preservation_host_remote_refused'],
  ['{"ok":false,"code":"not_immutable"}','preservation_host_remote_refused_not_immutable'],
  ['{"ok":false,"code":"password=secret"}','preservation_host_remote_refused'],
  ['{"ok":true}','preservation_host_invalid_transport_receipt'],
  ['broken-json','preservation_host_invalid_transport_receipt']]){
  const child=transportChild();const transport=createFixedTransport(()=>{queueMicrotask(()=>{child.stdout.write(output);child.emit("close",0);});return child;});
  await assert.rejects(transport({action:"source-operation-id"},30000),error=>error.message===reason && !error.message.includes("secret"));
 }
});
test("actual remote source refusal envelope emits safe immutable failure without weakening gate",()=>{
 const program='import ast,sys\nsource=sys.stdin.read();tree=ast.parse(source)\nnode=next(n for n in tree.body if isinstance(n,ast.Try) and any(isinstance(x,ast.Assign) and any(isinstance(t,ast.Name) and t.id=="value" for t in x.targets) for x in n.body))\nimport json\ndef execute():raise RuntimeError("not_immutable")\ndef stop_child():pass\nexec(compile(ast.Module(body=[node],type_ignores=[]),"<remote-envelope>","exec"))\n';
 const result=spawnSync("python3",["-c",program],{input:remotePython,encoding:"utf8"});assert.equal(result.status,0,result.stderr);
 assert.deepEqual(JSON.parse(result.stdout),{ok:false,reason:"fixed-operation-refused",code:"not_immutable"});
});
