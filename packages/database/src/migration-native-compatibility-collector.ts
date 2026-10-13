import { createHash } from "node:crypto";
import { Pool } from "pg";
import { verifyProductionCompatibilityApproval, type ProductionCompatibilityApproval } from "./migration-production-compatibility-approval.js";
import { migrationCutoverCanonicalJson, migrationCutoverDigest, POSTGRES_COMPATIBILITY_GUARD_CHECKS,
  type WriterFencePolicy } from "./migration-cutover-coordinator.js";
import type { PostgresBusinessOptions, PostgresBusinessRuntime } from "./postgres-business-driver.js";
import type { PostgresResult, createPostgresUnitOfWork, PostgresPool } from "./postgres-unit-of-work.js";

export interface NativeCompatibilityStatement { sql: string; values: unknown[] }
export interface NativeCompatibilityCase {
  table: string; operation: "insert" | "update" | "delete";
  candidate: NativeCompatibilityStatement; compatibleRead: NativeCompatibilityStatement;
  expectedReadSha256: string; compatibleWrite: NativeCompatibilityStatement;
}
export interface NativeCompatibilityGuard {
  check: typeof POSTGRES_COMPATIBILITY_GUARD_CHECKS[number];
  precondition: NativeCompatibilityStatement; preconditionSha256: string;
  attempt: NativeCompatibilityStatement; expectedSqlState: string | null;
  preserved: NativeCompatibilityStatement; preservedSha256: string;
}
export interface NativeCompatibilityProgram {
  cases: NativeCompatibilityCase[]; guards: NativeCompatibilityGuard[];
  rollbackProbe: NativeCompatibilityStatement;
}
const identifier = /^[a-z_][a-z0-9_]{0,62}$/;
const hash = /^[a-f0-9]{64}$/;
const fail = (code: string): never => { throw new Error(`Native compatibility refused: ${code}`); };
const need = (value: unknown, code: string): void => { if (!value) fail(code); };
const sha = (value: unknown): string => createHash("sha256").update(migrationCutoverCanonicalJson(value)).digest("hex");
function checkedStatement(statement: NativeCompatibilityStatement, operation?: string): void {
  need(statement && typeof statement.sql === "string" && statement.sql.length <= 16384
    && !statement.sql.includes(";") && Array.isArray(statement.values)
    && statement.values.length <= 128 && Buffer.byteLength(migrationCutoverCanonicalJson(statement.values)) <= 65536,
    "statement-bound");
  need(operation ? new RegExp(`^\\s*${operation}\\b`, "i").test(statement.sql)
    : /^\s*(SELECT|INSERT|UPDATE|DELETE)\b/i.test(statement.sql), "statement-kind");
}
function boundedResult(result: PostgresResult): void {
  need(Array.isArray(result.rows) && result.rows.length <= 4096
    && Buffer.byteLength(migrationCutoverCanonicalJson(result.rows)) <= 1048576, "result-bound");
}
export interface NativeCompatibilityOptions {
  policy: WriterFencePolicy; program: NativeCompatibilityProgram;
  candidate: PostgresBusinessRuntime; compatible: PostgresBusinessRuntime;
  deadline: number; clock: () => number;
  reconcileCommitUnknown: () => Promise<{ receipt: unknown; committed: true; reconciled: true }>;
}
export async function collectNativePostgresCompatibility(options: NativeCompatibilityOptions) {
  return collectNativeCompatibility(options, 5434);
}
/** Production native entry must verify process, release, role, registry and actual cluster pins before calling. */
export async function collectNativeProductionPostgresCompatibility(
  options: NativeCompatibilityOptions & { approval: ProductionCompatibilityApproval },
) {
  verifyProductionCompatibilityApproval({ policy: options.policy, program: options.program, approval: options.approval, now: options.clock() });
  return collectNativeCompatibility({ ...options,
    deadline: Math.min(options.deadline, Date.parse(options.approval.expiresAt)) }, 5432);
}
async function collectNativeCompatibility(options: NativeCompatibilityOptions, port: 5432 | 5434) {
  const { policy, program, candidate, compatible } = options;
  need(policy.evidenceMode === "production-observation" && policy.postgresRollbackCatalog?.length
    && policy.postgresRollbackVerifier, "approved-policy-required");
  const catalog = policy.postgresRollbackCatalog!;
  need(catalog.length <= 256 && catalog.every(item => identifier.test(item.table)), "catalog-bound");
  need(program.cases.length <= 768 && program.guards.length === POSTGRES_COMPATIBILITY_GUARD_CHECKS.length,
    "program-bound");
  const expectedCases = catalog.flatMap(item => item.operations.map(operation => `${item.table}:${operation}`)).sort();
  need(migrationCutoverCanonicalJson(program.cases.map(item => `${item.table}:${item.operation}`).sort())
    === migrationCutoverCanonicalJson(expectedCases), "operation-coverage");
  need(new Set(program.guards.map(item => item.check)).size === program.guards.length
    && POSTGRES_COMPATIBILITY_GUARD_CHECKS.every(name => program.guards.some(item => item.check === name)), "guard-coverage");
  let statements = 0;
  const started = options.clock();
  const budget = () => need(options.clock() >= started && options.clock() < options.deadline
    && statements < Math.min(policy.budgets.maximumSqlStatements, 10000), "original-budget");
  const run = async (runtime: PostgresBusinessRuntime, statement: NativeCompatibilityStatement) => {
    budget(); checkedStatement(statement); statements++;
    const result = await runtime.run(tx => tx.query(statement.sql, statement.values));
    boundedResult(result); budget(); return result;
  };
  budget();
  const before = [await candidate.probe(), await compatible.probe()];
  budget();
  for (const [index, identity] of before.entries()) {
    const expected = index === 0 ? policy.binding.target : policy.binding.rollbackTarget;
    need(identity.database === expected.database && identity.schema === expected.schema
      && identity.generation === expected.generation && identity.schemaFingerprint === expected.schemaSha256
      && identity.serverAddress === expected.serverAddress && identity.serverPort === expected.serverPort
      && identity.serverPort === port && identity.serverAddress === "127.0.0.1", "private-target-identity");
  }
  need(before[0]!.database === before[1]!.database && before[0]!.schema === before[1]!.schema,
    "same-live-data-required");
  const trace: unknown[] = [];
  const cases = [];
  let firstWriteAt: number | null = null;
  for (const item of program.cases) {
    checkedStatement(item.candidate, item.operation); checkedStatement(item.compatibleWrite, item.operation);
    checkedStatement(item.compatibleRead, "SELECT");
    need(hash.test(item.expectedReadSha256), "read-expectation");
    const committed = await run(candidate, item.candidate);
    need(committed.rowCount !== null && committed.rowCount > 0, "candidate-did-not-mutate");
    firstWriteAt ??= options.clock();
    const read = await run(compatible, item.compatibleRead);
    need(sha(read.rows) === item.expectedReadSha256, "compatible-read-mismatch");
    const written = await run(compatible, item.compatibleWrite);
    need(written.rowCount !== null && written.rowCount > 0, "compatible-did-not-mutate");
    const receipt = { table: item.table, operation: item.operation,
      committedReceiptSha256: sha({ program: sha(item.candidate), result: committed }),
      compatibleReadReceiptSha256: sha({ program: sha(item.compatibleRead), result: read }),
      compatibleWriteReceiptSha256: sha({ program: sha(item.compatibleWrite), result: written }) };
    cases.push(receipt); trace.push(receipt);
  }
  const guardChecks = [];
  for (const guard of program.guards) {
    checkedStatement(guard.precondition, "SELECT"); checkedStatement(guard.preserved, "SELECT");
    need(hash.test(guard.preconditionSha256) && hash.test(guard.preservedSha256), "guard-expectation");
    const precondition = await run(compatible, guard.precondition);
    need(sha(precondition.rows) === guard.preconditionSha256 && precondition.rows.length > 0, "guard-precondition");
    let measured: unknown;
    if (guard.expectedSqlState === null) {
      const result = await run(compatible, guard.attempt);
      need(result.rowCount === 0, "guard-allowed-mutation"); measured = { affected: 0 };
    } else {
      need(["23505", "23514", "42501", "P0001"].includes(guard.expectedSqlState), "guard-sqlstate");
      let observed: string | null = null;
      try { await run(compatible, guard.attempt); }
      catch (error) {
        const code = (error as { code?: unknown }).code;
        if (typeof code === "string" && /^[A-Z0-9]{5}$/.test(code)) observed = code;
        else throw error;
      }
      need(observed === guard.expectedSqlState, "guard-not-rejected"); measured = { sqlState: observed };
    }
    const preserved = await run(compatible, guard.preserved);
    need(sha(preserved.rows) === guard.preservedSha256, "guard-state-changed");
    guardChecks.push({ check: guard.check, receiptSha256: sha({ program: sha(guard), measured,
      precondition: sha(precondition.rows), preserved: sha(preserved.rows) }) });
  }
  const readTable = async (runtime: PostgresBusinessRuntime, table: string) => {
    const schema = runtime === candidate ? policy.binding.target.schema : policy.binding.rollbackTarget.schema;
    need(identifier.test(schema) && identifier.test(table), "table-identifier");
    const digest = createHash("sha256");
    let count = 0;
    while (true) {
      const rows = await run(runtime, { sql: `SELECT to_jsonb(t)::text AS canonical_row FROM "${schema}"."${table}" AS t ORDER BY to_jsonb(t)::text COLLATE "C" LIMIT $1 OFFSET $2`, values: [256, count] });
      for (const row of rows.rows) {
        need(typeof row.canonical_row === "string", "row-format");
        digest.update(row.canonical_row as string).update("\n");
      }
      count += rows.rows.length;
      if (rows.rows.length < 256) break;
    }
    return { rows: String(count), sha256: digest.digest("hex") };
  };
  const rollbackBefore = [];
  for (const entry of catalog) rollbackBefore.push(await readTable(candidate, entry.table));
  checkedStatement(program.rollbackProbe);
  need(/^\s*(INSERT|UPDATE|DELETE)\b/i.test(program.rollbackProbe.sql), "rollback-probe-kind");
  const rollbackSignal = new Error("collector-parent-rollback");
  let rolledBack = false;
  budget(); statements++;
  try {
    await candidate.run(async tx => {
      const result = await tx.query(program.rollbackProbe.sql, program.rollbackProbe.values);
      boundedResult(result); need(result.rowCount !== null && result.rowCount > 0, "rollback-probe-did-not-mutate");
      await candidate.run(async () => { throw rollbackSignal; });
    });
  } catch (error) { if (error !== rollbackSignal) throw error; rolledBack = true; }
  need(rolledBack, "parent-rollback-not-observed");
  const rollbackAfter = [];
  for (const entry of catalog) rollbackAfter.push(await readTable(compatible, entry.table));
  need(sha(rollbackBefore) === sha(rollbackAfter), "parent-rollback-state-changed");
  const rollbackReceipt = sha({ program: sha(program.rollbackProbe), before: rollbackBefore, after: rollbackAfter,
    outcome: "native-parent-rollback" });
  budget();
  const reconciliation = await options.reconcileCommitUnknown();
  need(reconciliation.committed === true && reconciliation.reconciled === true, "commit-unknown-unreconciled");
  budget();
  const tableChecks = [];
  for (const entry of catalog) {
    const retained = await readTable(candidate, entry.table), recovered = await readTable(compatible, entry.table);
    need(retained.rows === recovered.rows && retained.sha256 === recovered.sha256, "retained-data-mismatch");
    tableChecks.push({ table: entry.table, retainedRows: retained.rows, recoveredRows: recovered.rows,
      retainedSha256: retained.sha256, recoveredSha256: recovered.sha256,
      cases: cases.filter(item => item.table === entry.table).map(({ table: _table, ...item }) => item) });
  }
  const after = [await candidate.probe(), await compatible.probe()];
  need(sha(before) === sha(after), "session-identity-changed"); budget();
  const completed = options.clock();
  need(firstWriteAt !== null && started < firstWriteAt && firstWriteAt < completed, "native-timeline");
  return { version: policy.version, binding: policy.binding, strategy: "compatible-postgres-release" as const,
    recoveryMode: "retain-live-postgres-data" as const, backend: "postgres" as const,
    candidate: policy.binding.target, compatible: policy.binding.rollbackTarget,
    candidateArtifactSha256: policy.binding.target.releaseSha256,
    compatibleArtifactSha256: policy.binding.rollbackTarget.releaseSha256,
    catalogSha256: migrationCutoverDigest(catalog), schemaProbeSha256: sha(before), mutationTraceSha256: sha(trace),
    parentTransactionRollbackReceiptSha256: rollbackReceipt,
    commitUnknownReconciliationReceiptSha256: sha(reconciliation.receipt),
    providerGuardSha256: migrationCutoverDigest(policy.guards.filter(item => item.kind === "provider")),
    deliveryGuardSha256: migrationCutoverDigest(policy.guards.filter(item => item.kind === "delivery")),
    startedAt: new Date(started).toISOString(), firstWriteAt: new Date(firstWriteAt!).toISOString(),
    completedAt: new Date(completed).toISOString(), tableChecks, guardChecks };
}

export function createNativeCommitAckLossProbe(options: PostgresBusinessOptions,
  unitOfWorkFactory: typeof createPostgresUnitOfWork, uncertainError: new (...args: any[]) => Error,
  compatible: PostgresBusinessRuntime, plan: {
    mutation: NativeCompatibilityStatement; lookup: NativeCompatibilityStatement; expectedRowsSha256: string;
  }, check: () => void) {
  const url = new URL(options.connectionString);
  need(url.hostname === "127.0.0.1" && url.port === "5434" && options.ssl === false, "private-ack-loss-endpoint");
  checkedStatement(plan.mutation); checkedStatement(plan.lookup, "SELECT");
  need(/^\s*(INSERT|UPDATE|DELETE)\b/i.test(plan.mutation.sql) && hash.test(plan.expectedRowsSha256), "ack-loss-program");
  const pool = new Pool({ host: "127.0.0.1", port: 5434, database: options.target.database,
    user: options.target.username, password: decodeURIComponent(url.password), ssl: false, options: "",
    max: 1, connectionTimeoutMillis: 2000, statement_timeout: 2000, query_timeout: 2500 });
  let idleError = false;
  pool.on("error", () => { idleError = true; });
  return {
    close: () => pool.end(),
    async run() {
      check(); need(!idleError, "ack-loss-pool-error");
      let committed = false, replyDropped = false;
      const adapter: PostgresPool = { async connect() {
        const client = await pool.connect();
        return { async query(text, values) {
          const result = await client.query(text, values);
          if (text === "COMMIT") { committed = true; replyDropped = true; throw new Error("controlled-commit-ack-loss"); }
          return { rows: result.rows, rowCount: result.rowCount };
        }, release(error) { client.release(error); } };
      } };
      const work = unitOfWorkFactory(adapter, { statementTimeoutMs: 2000, lockTimeoutMs: 500 });
      let uncertain = false;
      try { await work.run(async tx => {
        const result = await tx.query(plan.mutation.sql, plan.mutation.values);
        need(result.rowCount !== null && result.rowCount > 0, "ack-loss-no-mutation");
      }); } catch (error) { uncertain = error instanceof uncertainError; }
      need(committed && replyDropped && uncertain && !idleError, "actual-commit-unknown-not-observed"); check();
      const lookup = await compatible.run(tx => tx.query(plan.lookup.sql, plan.lookup.values));
      boundedResult(lookup);
      const recoveredSha256 = sha(lookup.rows);
      need(recoveredSha256 === plan.expectedRowsSha256, "actual-commit-not-reconciled"); check();
      return { committed: true as const, reconciled: true as const, receipt: {
        mode: "actual-postgres-controlled-commit-ack-loss", programSha256: sha(plan), committed, replyDropped, recoveredSha256 } };
    },
  };
}
