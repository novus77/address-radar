import { createHash, createPrivateKey, createPublicKey, randomUUID, sign } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readSync, realpathSync, writeSync, fsyncSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { hostname } from "node:os";
import { spawnSync } from "node:child_process";
import { createNativeCommitAckLossProbe, collectNativePostgresCompatibility, type NativeCompatibilityProgram } from "../packages/database/src/migration-native-compatibility-collector.js";
import { migrationCompatiblePostgresRollbackPayload, migrationCutoverCanonicalJson, type WriterFencePolicy,
  type CompatiblePostgresReleaseProof } from "../packages/database/src/migration-cutover-coordinator.js";
import { measureSqliteAdmissionCodeSha256, readSqliteAdmissionProtectedBytes, readSqliteAdmissionProtectedRecord } from "../packages/database/src/sqlite-writer-admission.js";
import type { PostgresBusinessOptions, PostgresBusinessRuntime } from "../packages/database/src/postgres-business-driver.js";

const hashPattern = /^[a-f0-9]{64}$/;
const sha = (raw: string | Buffer): string => createHash("sha256").update(raw).digest("hex");
const need = (value: unknown, code: string): void => { if (!value) throw new Error(code); };
function record(path: string, pin: string, privateFile = true): any {
  need(hashPattern.test(pin), "record-pin");
  if (privateFile) {
    need((lstatSync(path).mode & 0o777) === 0o600 && (lstatSync(dirname(path)).mode & 0o777) === 0o700, "private-record");
  }
  const result = readSqliteAdmissionProtectedRecord(path);
  need(result.sha256 === pin, "record-changed");
  return result.value;
}
function endpoint(options: PostgresBusinessOptions): URL {
  const url = new URL(options.connectionString);
  need(["postgres:", "postgresql:"].includes(url.protocol) && url.hostname === "127.0.0.1" && url.port === "5434"
    && !url.search && !url.hash && options.ssl === false && options.maximumConnections === 1
    && options.statementTimeoutMs <= 2000 && options.lockTimeoutMs <= 500
    && options.connectionTimeoutMs <= 2000 && options.shutdownTimeoutMs <= 20000,
    "private-endpoint-or-budget");
  return url;
}
function ownedBytes(path: string, uid: number, maximum: number): Buffer {
  const before = lstatSync(path);
  need(before.isFile() && before.uid === uid && before.nlink === 1 && before.size <= maximum, "fixture-file");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd);
    need(opened.dev === before.dev && opened.ino === before.ino, "fixture-file-replaced");
    const raw = Buffer.alloc(maximum + 1), amount = readSync(fd, raw, 0, raw.length, null), after = fstatSync(fd), live = lstatSync(path);
    need(amount <= maximum && after.dev === before.dev && after.ino === before.ino && live.dev === before.dev && live.ino === before.ino
      && after.size === before.size && after.mtimeMs === before.mtimeMs && after.ctimeMs === before.ctimeMs, "fixture-file-replaced");
    return raw.subarray(0, amount);
  } finally { closeSync(fd); }
}
function fixture(job: any): void {
  // Cross-UID data/exe reads are done by the outside root wrapper, not by the
  // capability-free sandbox. Its real pg_controldata receipt is admission-bound.
  const binding = readSqliteAdmissionProtectedRecord(job.managedAdmissionPath).value as any;
  const path = job.managedAdmissionPath.replace(/binding[.]json$/, "fixture.json");
  const measured = record(path, binding.private_fixture_process_receipt_sha256);
  need(measured.version === 1 && measured.nonce === job.fixture.nonce
    && measured.record_sha256 === job.expiryRecordSha256 && measured.port === 5434
    && measured.pid === job.fixture.pid && measured.uid === job.fixture.uid
    && String(measured.process_ticks) === String(job.fixture.startTicks)
    && JSON.stringify(measured.root_identity) === JSON.stringify(job.fixture.rootIdentity)
    && JSON.stringify(measured.data_identity) === JSON.stringify(job.fixture.dataIdentity), "outside-fixture-measurement");
  const stat = readFileSync("/proc/" + measured.pid + "/stat", "utf8");
  const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
  need(fields[0] !== "Z" && fields[0] !== "X" && fields[19] === String(measured.process_ticks), "postmaster-lifetime");
}
export function validatePrivateBackendLineage(raw: string, parentPid: number): void {
  const fields = raw.slice(raw.lastIndexOf(")") + 2).trim().split(/\s+/);
  need(fields.length >= 20 && fields[0] !== "Z" && fields[0] !== "X"
    && fields[1] === String(parentPid) && /^[0-9]+$/.test(fields[19]!), "private-backend-lineage");
}
export function validateManagedCollectorBinding(job: any, expiry: any, binding: any): string {
  need(/^[a-f0-9]{16}$/.test(job.managedRequestNonce) && /^[a-f0-9]{16}$/.test(job.fixture.nonce), "managed-request");
  const control = "/var/lib/address-radar-rehearsal-artifact-control/" + job.fixture.nonce;
  const unit = "radar-rehearsal-" + job.fixture.nonce + "-verifier-" + job.managedRequestNonce + ".service";
  const path = control + "/invocations/" + job.managedRequestNonce + "-verifier.binding.json";
  need(job.managedAdmissionPath === path && expiry.nonce === job.fixture.nonce
    && expiry.artifacts.control.root === control && binding.unit === unit
    && binding.role === "verifier" && binding.request_nonce === job.managedRequestNonce
    && binding.record_sha256 === job.expiryRecordSha256
    && /^[a-f0-9]{32}$/.test(binding.invocation_id)
    && typeof binding.control_group === "string" && /^\/[A-Za-z0-9_.@:/-]+$/.test(binding.control_group)
    && !binding.control_group.split("/").includes("..")
    && Array.isArray(binding.identity) && binding.identity.length === 2
    && binding.identity.every((item: unknown) => Number.isSafeInteger(item) && Number(item) >= 0), "managed-binding");
  const output = control + "/receipts/" + job.managedRequestNonce + "/proof.json";
  need(binding.policy.receipt_directory === dirname(output) && job.outputPath === output
    && Array.isArray(binding.receipt_identity) && binding.receipt_identity.length === 2
    && binding.receipt_identity.every((item: unknown) => Number.isSafeInteger(item) && Number(item) >= 0), "managed-receipt-binding");
  return output;
}
export function validateCollectorAuthorityScopes(registry: any, authority: any, expectedSha256: string): void {
  need(hashPattern.test(expectedSha256) && Array.isArray(registry.scopes)
    && sha(migrationCutoverCanonicalJson(registry.scopes)) === expectedSha256
    && registry.scopesSha256 === expectedSha256, "authority-scope-pin");
  const ids = registry.scopes.map((item: any) => item.id);
  need(ids.every((item: unknown) => typeof item === "string") && new Set(ids).size === ids.length
    && ids.length > 0 && Array.isArray(authority.scopeIds)
    && authority.scopeIds.length === ids.length && new Set(authority.scopeIds).size === ids.length
    && authority.scopeIds.every((id: unknown) => ids.includes(id)), "authority-scope-coverage");
}
function managed(job: any): { output: string; receiptIdentity: number[] } {
  const expiry = record(job.expiryRecordPath, job.expiryRecordSha256);
  const pinnedBinding = readSqliteAdmissionProtectedRecord(job.managedAdmissionPath);
  need((lstatSync(job.managedAdmissionPath).mode & 0o777) === 0o600, "private-binding");
  const binding = pinnedBinding.value as any;
  const admit = readSqliteAdmissionProtectedRecord(job.managedAdmissionPath.replace(/binding[.]json$/, "admit.json"));
  need(Object.keys(admit.value as object).length === 1
    && (admit.value as any).binding_sha256 === pinnedBinding.sha256, "managed-admit-chain");
  need(binding.lane === "private-pg5434-cud" && binding.db_readonly_sha256 === null
    && binding.private_fixture_authority_sha256 === job.privateFixtureAuthoritySha256, "private-cud-lane");
  const output = validateManagedCollectorBinding(job, expiry, binding);
  need(job.fixture.uid === expiry.uid && job.fixture.pid === expiry.pid
    && String(job.fixture.startTicks) === String(expiry.process_ticks)
    && JSON.stringify(job.fixture.rootIdentity) === JSON.stringify(expiry.root_identity)
    && JSON.stringify(job.fixture.dataIdentity) === JSON.stringify(expiry.data_identity), "expiry-postmaster-binding");
  need(binding.invocation_id === process.env.INVOCATION_ID, "managed-admission");
  const control = lstatSync(expiry.artifacts.control.root);
  need(control.isDirectory() && control.uid === 0 && (control.mode & 0o777) === 0o700
    && JSON.stringify([control.dev, control.ino]) === JSON.stringify(expiry.artifacts.control.identity), "managed-control-replaced");
  const receipt = lstatSync(dirname(output));
  need(receipt.isDirectory() && receipt.uid === 0 && (receipt.mode & 0o777) === 0o700
    && JSON.stringify([receipt.dev, receipt.ino]) === JSON.stringify(binding.receipt_identity), "managed-receipt-replaced");
  need(measureSqliteAdmissionCodeSha256(job.systemctl.path) === job.systemctl.sha256, "systemctl-pin");
  const result = spawnSync(job.systemctl.path, ["show", "--no-pager", "--property=Id,Transient,InvocationID,ControlGroup,ActiveState", "--", binding.unit],
    { encoding: "utf8", timeout: 2000, maxBuffer: 16384, env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" } });
  need(result.status === 0 && !result.error, "managed-query");
  const values: Record<string, string> = {};
  for (const line of result.stdout.trim().split("\n")) {
    const separator = line.indexOf("=");
    need(separator > 0 && !Object.hasOwn(values, line.slice(0, separator)), "managed-properties");
    values[line.slice(0, separator)] = line.slice(separator + 1);
  }
  need(values.Id === binding.unit && values.Transient === "yes" && values.InvocationID === binding.invocation_id
    && values.ActiveState === "active" && values.ControlGroup === binding.control_group, "managed-unit");
  need(readFileSync("/proc/self/cgroup", "utf8").trim() === "0::" + binding.control_group, "managed-cgroup");
  const info = lstatSync("/sys/fs/cgroup" + binding.control_group);
  need(info.isDirectory() && JSON.stringify([info.dev, info.ino]) === JSON.stringify(binding.identity), "managed-cgroup-replaced");
  return { output, receiptIdentity: binding.receipt_identity };
}
export function validatePrivateFixtureRoleMeasurement(row: any, expected: any, nonce: string): void {
  need(row.role === expected.role && row.session_role === expected.role && row.database === expected.database
    && row.host === "127.0.0.1" && row.port === 5434
    && /^[a-f0-9]{16}$/.test(nonce) && Number.isSafeInteger(row.backend_pid) && row.backend_pid > 0, "actual-fixture-session");
  for (const field of ["privileges_safe", "set_role_safe", "database_scope_safe", "ddl_safe", "ownership_safe", "writes_scoped", "definer_safe", "extensions_safe"]) {
    need(row[field] === true, "actual-fixture-role-authority");
  }
}
export const privateFixtureRoleSql = `SELECT current_user AS role, session_user AS session_role,
  current_database() AS database, pg_catalog.host(inet_server_addr()) AS host, inet_server_port() AS port,
  pg_backend_pid() AS backend_pid,
  NOT (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls)
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.member=r.oid) AS privileges_safe,
  NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles x WHERE x.oid<>r.oid
    AND pg_catalog.pg_has_role(session_user,x.oid,'SET')) AS set_role_safe,
  NOT EXISTS (SELECT 1 FROM pg_catalog.pg_database d WHERE d.datname<>current_database()
    AND d.datallowconn AND pg_catalog.has_database_privilege(r.oid,d.oid,'CONNECT')) AS database_scope_safe,
  NOT pg_catalog.has_database_privilege(r.oid,current_database(),'CREATE')
    AND NOT pg_catalog.has_database_privilege(r.oid,current_database(),'TEMPORARY')
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_namespace n WHERE pg_catalog.has_schema_privilege(r.oid,n.oid,'CREATE')) AS ddl_safe,
  NOT EXISTS (SELECT 1 FROM pg_catalog.pg_database d WHERE d.datdba=r.oid)
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspowner=r.oid)
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c WHERE c.relowner=r.oid) AS ownership_safe,
  NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname<>$1 AND n.nspname!~'^pg_' AND n.nspname<>'information_schema'
    AND c.relkind IN ('r','p','v','m','f')
    AND (pg_catalog.has_table_privilege(r.oid,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      OR pg_catalog.has_any_column_privilege(r.oid,c.oid,'INSERT,UPDATE,REFERENCES')))
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE c.relkind='S' AND n.nspname<>$1 AND n.nspname!~'^pg_'
      AND pg_catalog.has_sequence_privilege(r.oid,c.oid,'USAGE,UPDATE')) AS writes_scoped,
  NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
    WHERE p.prosecdef AND n.nspname!~'^pg_' AND pg_catalog.has_function_privilege(r.oid,p.oid,'EXECUTE')) AS definer_safe,
  NOT EXISTS (SELECT 1 FROM pg_catalog.pg_extension e WHERE e.extname<>'plpgsql')
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_foreign_server s WHERE pg_catalog.has_server_privilege(r.oid,s.oid,'USAGE')) AS extensions_safe
  FROM pg_catalog.pg_roles r WHERE r.rolname=current_user`;
export async function nativeCompatibilityMain(args: string[]): Promise<void> {
  const started = performance.now();
  need(process.platform === "linux" && process.geteuid?.() === 0 && args.length === 4
    && args[0] === "--job" && args[2] === "--job-sha256", "native-root-job");
  const job = record(args[1]!, args[3]!);
  need(job.version === 1 && /^[a-f0-9]{32}$/.test(job.requestId) && Number.isSafeInteger(job.deadlineSeconds)
    && job.deadlineSeconds > 0 && job.deadlineSeconds <= 1800, "job-budget");
  const policy = record(job.policyPath, job.policySha256) as WriterFencePolicy;
  need(policy.evidenceMode === "production-observation" && policy.hostId === hostname()
    && policy.bootId === readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(), "policy-host");
  const windowEnd = Date.parse(policy.deadlines.windowEnd);
  need(Date.parse(policy.deadlines.windowStart) <= Date.now() && Date.now() < windowEnd, "policy-window");
  let monoDeadline = Math.min(started + job.deadlineSeconds * 1000, performance.now() + windowEnd - Date.now());
  const clock = () => { need(performance.now() < monoDeadline, "original-job-deadline"); return Date.now(); };
  clock(); managed(job); fixture(job);
  const registry = record(job.registryPath, job.registrySha256);
  need(/^\/var\/lib\/address-radar-migration-authority\/[a-f0-9]{16}\/registry.json$/.test(job.registryPath)
    && registry.provenance === "new-local-operator-bootstrap", "local-authority-root");
  const authority = registry.authorities.find((item: any) => item.role === "compatibility-verifier");
  const entrySha = measureSqliteAdmissionCodeSha256(realpathSync(fileURLToPath(import.meta.url)));
  need(authority && authority.collectorSha256 === entrySha && authority.kinds.length === 1 && authority.kinds[0] === "rehearsal"
    && authority.privateFile === "compatibility-verifier.private.pem", "collector-registration");
  validateCollectorAuthorityScopes(registry, authority, job.expectedScopesSha256);
  const verifier = policy.collectors.find(item => item.issuerId === authority.issuerId && item.keyId === authority.keyId);
  need(verifier?.publicKeyBase64 === authority.publicKeyBase64 && verifier?.collectorSha256 === entrySha
    && policy.postgresRollbackVerifier?.keyId === authority.keyId
    && policy.postgresRollbackVerifier?.issuerId === authority.issuerId, "collector-policy");
  const privateAuthority = record(job.privateFixtureAuthorityPath, job.privateFixtureAuthoritySha256);
  need(privateAuthority.version === 1 && privateAuthority.lane === "private-pg5434-cud"
    && privateAuthority.nonce === job.fixture.nonce && privateAuthority.requestNonce === job.managedRequestNonce
    && privateAuthority.expiryRecordSha256 === job.expiryRecordSha256
    && Number.isSafeInteger(privateAuthority.expiresAt) && Date.now() < privateAuthority.expiresAt * 1000
    && Array.isArray(privateAuthority.targets) && privateAuthority.targets.length === 2, "private-fixture-authority");
  monoDeadline = Math.min(monoDeadline, performance.now() + privateAuthority.expiresAt * 1000 - Date.now());
  clock();
  const program = record(job.programPath, job.programSha256) as NativeCompatibilityProgram;
  const runtimes: PostgresBusinessRuntime[] = [];
  let ackProbe: ReturnType<typeof createNativeCommitAckLossProbe> | undefined;
  let resourcesClosed = false;
  try {
    const loaded: any[] = [];
    const optionsList: PostgresBusinessOptions[] = [];
    for (const [index, item] of [job.candidate, job.compatible].entries()) {
      const expected = index === 0 ? policy.binding.target : policy.binding.rollbackTarget;
      need(measureSqliteAdmissionCodeSha256(realpathSync(item.modulePath)) === item.moduleSha256
        && item.moduleSha256 === expected.releaseSha256, "actual-release-code-pin");
      const options = record(item.optionsPath, item.optionsSha256) as PostgresBusinessOptions;
      const url = endpoint(options);
      const approvedTarget = privateAuthority.targets[index];
      const prefix = "radar_rehearsal_" + job.fixture.nonce;
      need(approvedTarget.serverAddress === "127.0.0.1" && approvedTarget.serverPort === 5434
        && approvedTarget.database === options.target.database && approvedTarget.schema === options.target.schema
        && approvedTarget.role === options.target.username && approvedTarget.systemIdentifier === expected.systemIdentifier
        && decodeURIComponent(url.username) === options.target.username
        && decodeURIComponent(url.pathname.slice(1)) === options.target.database
        && [approvedTarget.database, approvedTarget.schema, approvedTarget.role].every((name: string) =>
          new RegExp("^" + prefix + "(?:_[a-z]+)?$").test(name)), "private-fixture-target-scope");
      need(options.target.database === expected.database && options.target.schema === expected.schema
        && options.target.generation === expected.generation && options.schemaFingerprint === expected.schemaSha256
        && expected.serverPort === 5434 && expected.serverAddress === "127.0.0.1", "native-target-binding");
      const module = await import(pathToFileURL(realpathSync(item.modulePath)).href);
      need(typeof module.createPostgresBusinessRuntime === "function" && typeof module.createPostgresUnitOfWork === "function" && typeof module.PostgresCommitUncertainError === "function", "native-release-api");
      loaded.push(module); optionsList.push(options);
      // Every factory is a measured runnable release artifact, never a documentation/library substitute.
      const runtime = module.createPostgresBusinessRuntime(options) as PostgresBusinessRuntime;
      runtimes.push(runtime); clock();
      const role = await runtime.run(tx => tx.query(privateFixtureRoleSql, [options.target.schema]));
      need(role.rows.length === 1, "actual-fixture-role-measurement");
      validatePrivateFixtureRoleMeasurement(role.rows[0], approvedTarget, job.fixture.nonce);
      const backendPid = Number(role.rows[0]!.backend_pid);
      need(lstatSync("/proc/" + backendPid).uid === job.fixture.uid, "private-backend-owner");
      validatePrivateBackendLineage(readFileSync("/proc/" + backendPid + "/stat", "utf8"), job.fixture.pid);
      clock(); managed(job); fixture(job);
      await runtime.probe();
      const binding = readSqliteAdmissionProtectedRecord(job.managedAdmissionPath).value as any;
      const actualFixture = record(job.managedAdmissionPath.replace(/binding[.]json$/, "fixture.json"), binding.private_fixture_process_receipt_sha256);
      need(actualFixture.system_identifier === expected.systemIdentifier, "actual-private-server");
      void url;
    }
    ackProbe = createNativeCommitAckLossProbe(optionsList[0]!, loaded[0]!.createPostgresUnitOfWork,
      loaded[0]!.PostgresCommitUncertainError, runtimes[1]!, job.commitUnknown, () => { clock(); });
    const measured = await collectNativePostgresCompatibility({ policy, program, candidate: runtimes[0]!, compatible: runtimes[1]!,
      deadline: windowEnd, clock, reconcileCommitUnknown: () => ackProbe!.run() });
    const closed = await Promise.allSettled(runtimes.map(runtime => runtime.close()));
    if (ackProbe) { await ackProbe.close(); ackProbe = undefined; }
    need(closed.every(item => item.status === "fulfilled") && runtimes.every(runtime => {
      const stats = runtime.statistics();
      return stats.state === "closed" && stats.activeOperations === 0 && stats.waitingConnections === 0;
    }), "native-runtime-not-closed");
    resourcesClosed = true;
    clock(); managed(job); fixture(job);
    const privatePath = dirname(job.registryPath) + "/" + authority.privateFile;
    need((lstatSync(privatePath).mode & 0o777) === 0o600 && (lstatSync(dirname(privatePath)).mode & 0o777) === 0o700, "private-authority");
    const bytes = readSqliteAdmissionProtectedBytes(privatePath);
    const key = createPrivateKey(bytes); bytes.fill(0);
    const publicKey = createPublicKey(key).export({ type: "spki", format: "der" }).toString("base64");
    need(key.asymmetricKeyType === "ed25519" && publicKey === authority.publicKeyBase64
      && registry.authorities.filter((item: any) => ["operator-authorization", "observer-collector"].includes(item.role))
        .every((item: any) => item.publicKeyBase64 !== publicKey), "independent-actual-key");
    const observedAt = new Date(clock()).toISOString();
    const proof = { ...measured, attestation: { issuerId: authority.issuerId, keyId: authority.keyId, observedAt,
      expiresAt: new Date(Math.min(windowEnd, Date.now() + policy.deadlines.maximumEvidenceAgeMs)).toISOString(),
      provenance: { hostId: policy.hostId, bootId: policy.bootId, collectorSha256: entrySha, runId: randomUUID(), sequence: "1",
        challengeId: policy.challengeId }, signatureBase64: "" } } as CompatiblePostgresReleaseProof;
    proof.attestation.signatureBase64 = sign(null, Buffer.from(migrationCompatiblePostgresRollbackPayload(proof)), key).toString("base64");
    const managedOutput = managed(job);
    const output = managedOutput.output;
    need(job.outputPath === output && (lstatSync(dirname(output)).mode & 0o777) === 0o700
      && lstatSync(dirname(output)).uid === 0, "output-namespace");
    for (let ancestor = dirname(output);; ancestor = dirname(ancestor)) {
      const info = lstatSync(ancestor);
      need(info.isDirectory() && info.uid === 0 && (info.mode & 0o022) === 0, "output-ancestor");
      if (ancestor === "/") break;
    }
    const parent = openSync(dirname(output), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const parentInfo = fstatSync(parent);
    if (!parentInfo.isDirectory() || parentInfo.uid !== 0 || (parentInfo.mode & 0o777) !== 0o700
      || JSON.stringify([parentInfo.dev, parentInfo.ino]) !== JSON.stringify(managedOutput.receiptIdentity)) {
      closeSync(parent); throw new Error("output-replaced-before-open");
    }
    let fd: number;
    try { fd = openSync(`/proc/self/fd/${parent}/proof.json`, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
    catch (error) { closeSync(parent); throw error; }
    try { const raw = Buffer.from(migrationCutoverCanonicalJson(proof)); let offset = 0;
      while (offset < raw.length) offset += writeSync(fd, raw, offset, raw.length - offset);
      fsyncSync(fd);
      const live = lstatSync(dirname(output));
      need(live.dev === parentInfo.dev && live.ino === parentInfo.ino && live.uid === 0
        && (live.mode & 0o777) === 0o700, "output-replaced");
      fsyncSync(parent);
    } finally { closeSync(fd); closeSync(parent); }
    process.stdout.write(JSON.stringify({ status: "native-compatibility-attested", proofSha256: sha(migrationCutoverCanonicalJson(proof)),
      collectorSha256: entrySha, tableChecks: proof.tableChecks.length, preparationReady: false, activationEnabled: false }) + "\n");
  } finally {
    if (!resourcesClosed) {
      const result = await Promise.allSettled(runtimes.map(runtime => runtime.close()));
      if (ackProbe) await ackProbe.close();
      need(result.every(item => item.status === "fulfilled"), "native-runtime-not-closed");
    }
  }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  nativeCompatibilityMain(process.argv.slice(2)).catch(() => {
    process.stdout.write('{"status":"native-compatibility-refused","preparationReady":false,"activationEnabled":false}\n');
    process.exitCode = 2;
  });
}
