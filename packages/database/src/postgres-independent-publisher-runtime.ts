import { Pool } from 'pg';
import { createPostgresUnitOfWork, type PostgresClient } from './postgres-unit-of-work.js';

/** A dedicated proof writer pool, never a six-service BusinessRuntime or SQLite fallback. */
export function createIndependentPostgresPublisherRuntime(input: {
  connectionString: string; schema: string; statementTimeoutMs: number; lockTimeoutMs: number;
}) {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(input.schema) || ['public', 'pg_catalog', 'information_schema'].includes(input.schema)
    || !Number.isSafeInteger(input.statementTimeoutMs) || input.statementTimeoutMs < 1 || input.statementTimeoutMs > 30000
    || !Number.isSafeInteger(input.lockTimeoutMs) || input.lockTimeoutMs < 1 || input.lockTimeoutMs > input.statementTimeoutMs) {
    throw new Error('Independent publisher runtime configuration rejected');
  }
  const pool = new Pool({ connectionString: input.connectionString, max: 1,
    connectionTimeoutMillis: 5000, idleTimeoutMillis: 10000, query_timeout: input.statementTimeoutMs,
    application_name: 'address-only-independent-publisher' });
  let poisoned = false, closed = false;
  pool.on('error', () => { poisoned = true; });
  const work = createPostgresUnitOfWork({ async connect(): Promise<PostgresClient> {
    if (poisoned || closed) throw new Error('Independent publisher runtime unavailable');
    const native = await pool.connect();
    let released = false, failure: Error | undefined;
    const onError = (error: Error) => { failure = error; poisoned = true; };
    native.on('error', onError);
    const release = (error?: Error) => {
      if (released) return; released = true;
      native.removeListener('error', onError); native.release(error ?? failure);
    };
    try {
      await native.query(`SELECT pg_catalog.set_config('search_path',$1,false),
        pg_catalog.set_config('statement_timeout',$2,false),pg_catalog.set_config('lock_timeout',$3,false),
        pg_catalog.set_config('idle_in_transaction_session_timeout','30000',false),
        pg_catalog.set_config('work_mem','1024kB',false),pg_catalog.set_config('synchronous_commit','on',false)`,
      [`"${input.schema}",pg_catalog`, String(input.statementTimeoutMs), String(input.lockTimeoutMs)]);
      if (failure || poisoned || closed) throw failure ?? new Error('Independent publisher runtime unavailable');
      return { async query(sql, values) {
        if (failure || poisoned || closed || released) throw failure ?? new Error('Independent publisher runtime unavailable');
        const result = await native.query(sql, values);
        if (failure) throw failure;
        return result;
      }, release };
    } catch (error) { release(error instanceof Error ? error : new Error('Independent publisher bootstrap rejected')); throw error; }
  } }, input);
  let closing: Promise<void> | undefined;
  return { run: work.run, close(): Promise<void> {
    if (!closing) { closed = true; closing = pool.end(); }
    return closing;
  } };
}
