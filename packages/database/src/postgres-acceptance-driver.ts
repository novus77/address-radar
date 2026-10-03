import { Pool } from "pg";
import { createPostgresUnitOfWork, type PostgresPool, type PostgresResult } from "./postgres-unit-of-work.js";

export interface PostgresAcceptanceOptions {
  readonly connectionString: string;
  readonly maximumConnections: number;
  readonly connectionTimeoutMs: number;
  readonly idleTimeoutMs: number;
  readonly statementTimeoutMs: number;
  readonly lockTimeoutMs: number;
}

export interface PostgresAcceptanceIdentity {
  readonly database: string;
  readonly username: string;
  readonly serverAddress: string;
  readonly serverPort: number;
}

export interface PostgresAcceptanceStatistics {
  readonly totalConnections: number;
  readonly idleConnections: number;
  readonly waitingConnections: number;
  readonly idleErrorCount: number;
  readonly lastIdleSqlState: string | null;
  readonly state: "ready" | "closing" | "closed";
}

export interface PostgresAcceptanceRuntime {
  readonly run: ReturnType<typeof createPostgresUnitOfWork>["run"];
  probe(): Promise<PostgresAcceptanceIdentity>;
  statistics(): PostgresAcceptanceStatistics;
  close(): Promise<void>;
}

function target(connectionString: string) {
  const invalid = () => new Error("PostgreSQL acceptance requires an explicit loopback _test database with credentials");
  try {
    const url = new URL(connectionString);
    const database = decodeURIComponent(url.pathname.slice(1));
    const username = decodeURIComponent(url.username);
    const password = decodeURIComponent(url.password);
    const port = Number(url.port);
    if (!["postgres:", "postgresql:"].includes(url.protocol)
      || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
      || url.search || url.hash || !url.port || !username || !password
      || !Number.isSafeInteger(port) || port < 1 || port > 65_535
      || !/^[A-Za-z_][A-Za-z0-9_]*_test$/.test(database) || database.length > 63
      || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(username) || username.length > 63) {
      throw invalid();
    }
    return { host: url.hostname === "[::1]" ? "::1" : url.hostname, port, database, username, password };
  } catch {
    // URL parser errors may include the original credential-bearing input.
    throw invalid();
  }
}

export function createPostgresAcceptanceRuntime(options: PostgresAcceptanceOptions): PostgresAcceptanceRuntime {
  const endpoint = target(options.connectionString);
  const budgets = [options.maximumConnections, options.connectionTimeoutMs, options.idleTimeoutMs,
    options.statementTimeoutMs, options.lockTimeoutMs];
  if (budgets.some(value => !Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647)
    || options.maximumConnections > 2 || options.lockTimeoutMs > options.statementTimeoutMs) {
    throw new Error("PostgreSQL acceptance resource limits must be explicit and bounded");
  }
  const pool = new Pool({
    host: endpoint.host, port: endpoint.port, database: endpoint.database,
    user: endpoint.username, password: endpoint.password, ssl: false, options: "",
    application_name: "address-radar-acceptance", max: options.maximumConnections,
    connectionTimeoutMillis: options.connectionTimeoutMs, idleTimeoutMillis: options.idleTimeoutMs,
  });
  let idleErrorCount = 0;
  let lastIdleSqlState: string | null = null;
  let closing = false;
  let closed = false;
  let shutdown: Promise<void> | undefined;
  pool.on("error", error => {
    idleErrorCount += 1;
    const code = (error as Error & { code?: unknown }).code;
    lastIdleSqlState = typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? code : null;
  });
  const adapter: PostgresPool = {
    async connect() {
      if (closing) throw new Error("PostgreSQL acceptance runtime is closing or closed");
      const client = await pool.connect();
      return {
        async query(text: string, values?: unknown[]): Promise<PostgresResult> {
          const response = await client.query<Record<string, unknown>>(text, values);
          // Schema fixtures can use simple-protocol batches; expose their final result.
          const result = Array.isArray(response) ? response.at(-1) : response;
          return { rows: result?.rows ?? [], rowCount: result?.rowCount ?? null };
        },
        release(error?: Error) { client.release(error); },
      };
    },
  };
  const work = createPostgresUnitOfWork(adapter, {
    statementTimeoutMs: options.statementTimeoutMs, lockTimeoutMs: options.lockTimeoutMs,
  });
  return Object.freeze({
    run: work.run,
    async probe(): Promise<PostgresAcceptanceIdentity> {
      return work.run(async tx => {
        const result = await tx.query("SELECT current_database() AS database, current_user AS username, host(inet_server_addr()) AS server_address, inet_server_port() AS server_port");
        const row = result.rows[0];
        if (!row || row.database !== endpoint.database || row.username !== endpoint.username
          || !["127.0.0.1", "::1"].includes(String(row.server_address))
          || typeof row.server_port !== "number" || !Number.isSafeInteger(row.server_port)) {
          throw new Error("PostgreSQL acceptance connection identity did not match the isolated target");
        }
        return Object.freeze({ database: endpoint.database, username: endpoint.username,
          serverAddress: String(row.server_address), serverPort: row.server_port });
      });
    },
    statistics(): PostgresAcceptanceStatistics {
      return Object.freeze({ totalConnections: pool.totalCount, idleConnections: pool.idleCount,
        waitingConnections: pool.waitingCount, idleErrorCount, lastIdleSqlState,
        state: closed ? "closed" : closing ? "closing" : "ready" });
    },
    close(): Promise<void> {
      if (!shutdown) {
        closing = true;
        shutdown = pool.end().then(() => { closed = true; });
      }
      return shutdown;
    },
  });
}
