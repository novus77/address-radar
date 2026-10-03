import { AsyncLocalStorage } from "node:async_hooks";

export interface PostgresResult {
  readonly rows: readonly Record<string, unknown>[];
  readonly rowCount: number | null;
}

export interface PostgresClient {
  query(text: string, values?: unknown[]): Promise<PostgresResult>;
  release(error?: Error): void;
}

export interface PostgresPool {
  connect(): Promise<PostgresClient>;
}

export interface PostgresTransaction {
  query(text: string, values?: readonly unknown[]): Promise<PostgresResult>;
}

export interface PostgresUnitOfWorkOptions {
  readonly statementTimeoutMs: number;
  readonly lockTimeoutMs: number;
}

interface TransactionState {
  readonly client: PostgresClient;
  readonly transaction: PostgresTransaction;
  readonly pending: Set<Promise<PostgresResult>>;
  active: boolean;
  failure: { readonly error: unknown } | null;
}

export class PostgresCommitUncertainError extends Error {
  constructor(cause: unknown) {
    super("PostgreSQL commit failed; reconcile the durable result before retrying", { cause });
    this.name = "PostgresCommitUncertainError";
  }
}

const asError = (value: unknown): Error => value instanceof Error ? value : new Error("PostgreSQL connection discarded");

export function createPostgresUnitOfWork(pool: PostgresPool, options: PostgresUnitOfWorkOptions) {
  for (const value of [options.statementTimeoutMs, options.lockTimeoutMs]) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error("PostgreSQL timeouts must be positive safe integers");
  }
  const scope = new AsyncLocalStorage<TransactionState>();

  async function run<T>(operation: (transaction: PostgresTransaction) => Promise<T>): Promise<T> {
    const parent = scope.getStore();
    if (parent) {
      if (!parent.active) throw new Error("PostgreSQL transaction scope is closed");
      try {
        return await operation(parent.transaction);
      } catch (error) {
        parent.failure ??= { error };
        throw error;
      }
    }

    const client = await pool.connect();
    let begun = false;
    let commitAttempted = false;
    let discard: Error | undefined;
    const pending = new Set<Promise<PostgresResult>>();
    const state: TransactionState = {
      client,
      pending,
      active: true,
      failure: null,
      transaction: Object.freeze({
        async query(text: string, values: readonly unknown[] = []): Promise<PostgresResult> {
          if (!state.active) throw new Error("PostgreSQL transaction scope is closed");
          // Track even unawaited SQL so completion cannot acknowledge an unfinished write.
          const request = Promise.resolve().then(() => client.query(text, [...values]));
          pending.add(request);
          void request.then(
            () => { pending.delete(request); },
            error => { pending.delete(request); state.failure ??= { error }; },
          );
          return request;
        },
      }),
    };

    try {
      await client.query("BEGIN");
      begun = true;
      await client.query(
        "SELECT set_config('statement_timeout', $1, true), set_config('lock_timeout', $2, true)",
        [String(options.statementTimeoutMs), String(options.lockTimeoutMs)],
      );
      const value = await scope.run(state, () => operation(state.transaction));
      state.active = false;
      await Promise.allSettled([...pending]);
      if (state.failure) throw state.failure.error;
      commitAttempted = true;
      try {
        await client.query("COMMIT");
      } catch (error) {
        throw new PostgresCommitUncertainError(error);
      }
      begun = false;
      return value;
    } catch (error) {
      state.active = false;
      await Promise.allSettled([...pending]);
      if (commitAttempted || !begun) discard = asError(error);
      if (begun) {
        try {
          await client.query("ROLLBACK");
        } catch (rollbackError) {
          discard = asError(rollbackError);
          throw new AggregateError([error, rollbackError], "PostgreSQL operation and rollback failed");
        }
      }
      throw error;
    } finally {
      state.active = false;
      client.release(discard);
    }
  }

  return Object.freeze({ run });
}
