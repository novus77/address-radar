import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPostgresBusinessRuntime, type PostgresBusinessOptions, type PostgresBusinessRuntime } from '../src/postgres-business-driver.js';
import { createPostgresConnectionGate } from '../src/postgres-connection-retirement.js';
import { PostgresCommitUncertainError } from '../src/postgres-unit-of-work.js';

const model = vi.hoisted(() => ({ live: 0, peak: 0, connections: 0, rejectedConnections: 0,
  pendingEnds: [] as Array<() => void>, autoEnd: false, failCommit: false, failConnect: false, endOnQuery: false }));
vi.mock('pg', async importOriginal => {
  const actual = await importOriginal<typeof import('pg')>();
  const { EventEmitter } = await import('node:events');
  class TransportClient extends EventEmitter {
    // These flags implement the installed pg-pool transport ABI, not production barrier logic.
    _queryable = true;
    _ending = false;
    private ended = false;
    private connected = false;
    connection = { stream: { destroy: () => { this.end(); } } };
    connect(callback: (error: Error | null) => void) {
      model.connections++;
      if (model.live >= 1) {
        model.rejectedConnections++;
        queueMicrotask(() => callback(Object.assign(new Error('model role connection limit'), { code: '53300' })));
        return;
      }
      this.connected = true; model.live++; model.peak = Math.max(model.peak, model.live);
      queueMicrotask(() => callback(model.failConnect ? new Error('model authentication rejected before socket end') : null));
    }
    async query(sql: string) {
      if (sql === 'END BEFORE RELEASE' && model.endOnQuery) {
        this._queryable = false;
        this.emit('error', new Error('model connection died during work'));
        this.end(); for (const finish of model.pendingEnds.splice(0)) finish();
      }
      if (sql === 'COMMIT' && model.failCommit) throw new Error('model lost commit acknowledgement');
      const rows = sql.includes('business-identity') ? [{ database: 'radar_business', username: 'radar_runtime',
        session_username: 'radar_runtime', server_address: '127.0.0.1', server_port: 5432,
        application_name: `scanner:${createHash('sha256').update('generation-1').digest('hex').slice(0, 16)}` }]
        : sql.includes('business-ledger-kind') ? [{ identity_valid: true, ledger_valid: true }]
        : sql.includes('business-privileges') ? [{ role_safe: true, schema_usage: true, database_create: false,
          database_temp: false, schema_create: false, schema_owner: false, outside_write: false,
          unsafe_privileges: false, unsafe_functions: false }]
        : sql.includes('business-ledger-probe') ? [{ database_name: 'radar_business', schema_name: 'business_v1',
          generation_id: 'generation-1', ledger_format: 1, version: 1, fingerprint: 'a'.repeat(64) }] : [];
      return { rows, rowCount: rows.length };
    }
    end(callback?: () => void): Promise<void> | void {
      this._ending = true;
      if (this.ended || !this.connected) { if (callback) { callback(); return; } return Promise.resolve(); }
      let resolve!: () => void;
      const promise = callback ? undefined : new Promise<void>(done => { resolve = done; });
      const finish = () => {
        if (!this.ended) { this.ended = true; model.live--; this.emit('end'); }
        callback?.(); resolve?.();
      };
      if (model.autoEnd) queueMicrotask(finish); else model.pendingEnds.push(finish);
      return promise;
    }
  }
  // The runtime supplies the guarded subclass through PoolConfig.Client; do not override it in the pool.
  return { ...actual, Client: TransportClient as unknown as typeof actual.Client };
});
const runtimes: PostgresBusinessRuntime[] = [];
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const finishEnds = () => { for (const finish of model.pendingEnds.splice(0)) finish(); };
function create(connectionTimeoutMs = 100, maximumPendingOperations = 0) {
  const options: PostgresBusinessOptions = {
    connectionString: 'postgresql://radar_runtime:fixture-only@127.0.0.1:5432/radar_business',
    target: { database: 'radar_business', username: 'radar_runtime', schema: 'business_v1', generation: 'generation-1', service: 'scanner' },
    access: 'runtime', schemaVersion: 1, schemaFingerprint: 'a'.repeat(64), ssl: false,
    maximumConnections: 1, serviceConnectionBudgets: { scanner: 1 }, serverMaximumConnections: 16,
    reservedConnections: 3, maximumPendingOperations, connectionTimeoutMs, idleTimeoutMs: 10,
    statementTimeoutMs: 1000, lockTimeoutMs: 500, idleTransactionTimeoutMs: 1000, shutdownTimeoutMs: 500, workMemKb: 1024,
  };
  const runtime = createPostgresBusinessRuntime(options); runtimes.push(runtime); return runtime;
}
beforeEach(() => { Object.assign(model, { live: 0, peak: 0, connections: 0, rejectedConnections: 0,
  pendingEnds: [], autoEnd: false, failCommit: false, failConnect: false, endOnQuery: false }); });
afterEach(async () => { model.autoEnd = true; finishEnds(); await Promise.allSettled(runtimes.splice(0).map(runtime => runtime.close())); });

describe('physical lifecycle with installed real pg-pool', () => {
  it('first becomes healthy idle, then fences real timer eviction until physical end', async () => {
    const runtime = create(); await runtime.probe();
    expect(runtime.statistics()).toMatchObject({ totalConnections: 1, idleConnections: 1 });
    expect(model.pendingEnds).toHaveLength(0);
    await delay(25); expect(runtime.statistics().totalConnections).toBe(0);
    expect(model.live).toBe(1); expect(model.pendingEnds).toHaveLength(1);
    const next = runtime.probe(); await delay(10); expect(model.connections).toBe(1);
    finishEnds(); await next; expect(model.connections).toBe(2); expect(model.peak).toBe(1);
  });
  it('bounds a stuck retirement and allows later recovery without another early socket', async () => {
    const runtime = create(30); await runtime.probe(); await delay(25);
    await expect(runtime.probe()).rejects.toThrow();
    expect(model.connections).toBe(1); expect(runtime.statistics().activeOperations).toBe(0);
    finishEnds(); await runtime.probe(); expect(model.peak).toBe(1);
  });
  it('does not acknowledge shutdown while idle eviction is physically unfinished', async () => {
    const runtime = create(); await runtime.probe(); await delay(25);
    let closed = false; const closing = runtime.close().then(() => { closed = true; });
    await delay(10); expect(closed).toBe(false); expect(runtime.statistics().state).toBe('closing');
    finishEnds(); await closing; expect(model.live).toBe(0);
  });
  it('does not create a stale end waiter when end precedes release(error)', async () => {
    const runtime = create(); model.endOnQuery = true;
    await expect(runtime.run(tx => tx.query('END BEFORE RELEASE'))).rejects.toThrow();
    expect(model.live).toBe(0); model.endOnQuery = false;
    await runtime.probe(); expect(model.connections).toBe(2); expect(model.peak).toBe(1);
    model.autoEnd = true; await runtime.close(); expect(runtime.statistics().state).toBe('closed');
  });
  it('fences failed handshake callbacks and pool-internal queued acquire before physical end', async () => {
    const runtime = create(150, 1); model.failConnect = true;
    const first = runtime.probe(); const rejected = expect(first).rejects.toThrow('authentication rejected');
    const queued = runtime.probe();
    await rejected; await delay(10);
    expect(model.live).toBe(1); expect(model.connections).toBe(1);
    model.failConnect = false; finishEnds(); await queued;
    expect(model.connections).toBe(2); expect(model.rejectedConnections).toBe(0); expect(model.peak).toBe(1);
  });
  it('retains uncertain commit semantics without replay', async () => {
    const runtime = create(); const operation = vi.fn(async () => 'not acknowledged'); model.failCommit = true;
    await expect(runtime.run(operation)).rejects.toBeInstanceOf(PostgresCommitUncertainError);
    model.failCommit = false; const next = runtime.probe(); await delay(10); expect(model.connections).toBe(1);
    finishEnds(); await next; expect(operation).toHaveBeenCalledTimes(1); expect(model.peak).toBe(1);
  });
  it('removes timed-out and aborted waiter subscriptions instead of accumulating continuations', async () => {
    const gate = createPostgresConnectionGate(1), controller = new AbortController();
    const release = await gate.acquire(100, controller.signal);
    for (let index = 0; index < 5; index++) {
      await expect(gate.acquire(2, new AbortController().signal)).rejects.toThrow('RETIREMENT_TIMEOUT');
      expect(gate.statistics()).toEqual({ active: 1, waiting: 0, emptyWaiters: 0 });
    }
    const abort = new AbortController(); const waiting = gate.acquire(100, abort.signal);
    const assertion = expect(waiting).rejects.toThrow('ACQUIRE_ABORTED'); abort.abort(); await assertion;
    expect(gate.statistics().waiting).toBe(0); release(); expect(gate.statistics().active).toBe(0);
  });
});
