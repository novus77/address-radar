import { describe, expect, it } from "vitest";
import { createPostgresUnitOfWork, PostgresCommitUncertainError, type PostgresClient, type PostgresTransaction } from "../src/postgres-unit-of-work.js";

const options = { statementTimeoutMs: 2_000, lockTimeoutMs: 500 };
function fixture(failOn?: string) {
  const statements: string[] = [];
  const releases: Array<Error | undefined> = [];
  let connections = 0;
  const client: PostgresClient = {
    async query(text) {
      statements.push(text);
      if (text === failOn) throw new Error("query failed");
      return { rows: [], rowCount: 0 };
    },
    release(error) { releases.push(error); },
  };
  const work = createPostgresUnitOfWork({ async connect() { connections += 1; return client; } }, options);
  return { work, statements, releases, connections: () => connections };
}

describe("PostgreSQL unit of work", () => {
  it("acknowledges only after commit and releases the connection", async () => {
    const f = fixture();
    await expect(f.work.run(async tx => { await tx.query("INSERT"); return "receipt"; })).resolves.toBe("receipt");
    expect(f.statements.at(-1)).toBe("COMMIT");
    expect(f.releases).toEqual([undefined]);
  });

  it("rolls back callback errors", async () => {
    const f = fixture();
    await expect(f.work.run(async () => { throw new Error("parse failed"); })).rejects.toThrow("parse failed");
    expect(f.statements.at(-1)).toBe("ROLLBACK");
    expect(f.statements).not.toContain("COMMIT");
  });

  it("reuses the client when repositories compose in the same scope", async () => {
    const f = fixture();
    await f.work.run(async outer => f.work.run(async inner => {
      expect(inner).toBe(outer);
      await inner.query("INSERT");
    }));
    expect(f.connections()).toBe(1);
    expect(f.statements.filter(text => text === "BEGIN")).toHaveLength(1);
  });

  it("cannot commit after a nested failure is caught by the caller", async () => {
    const f = fixture();
    await expect(f.work.run(async () => {
      await f.work.run(async () => { throw new Error("nested failed"); }).catch(() => undefined);
    })).rejects.toThrow("nested failed");
    expect(f.statements.at(-1)).toBe("ROLLBACK");
  });

  it("cannot commit after a SQL error is caught by the caller", async () => {
    const f = fixture("BROKEN");
    await expect(f.work.run(async tx => { await tx.query("BROKEN").catch(() => undefined); })).rejects.toThrow("query failed");
    expect(f.statements).not.toContain("COMMIT");
  });

  it("waits for a submitted write even when its promise is not returned", async () => {
    const f = fixture();
    await f.work.run(async tx => { void tx.query("INSERT"); });
    expect(f.statements.indexOf("INSERT")).toBeLessThan(f.statements.indexOf("COMMIT"));
  });

  it("rejects a transaction handle used after completion", async () => {
    const f = fixture();
    let captured: PostgresTransaction | undefined;
    await f.work.run(async tx => { captured = tx; });
    await expect(captured!.query("LATE")).rejects.toThrow("scope is closed");
    expect(f.statements).not.toContain("LATE");
  });

  it("does not retry an uncertain commit and discards its client", async () => {
    const f = fixture("COMMIT");
    await expect(f.work.run(async () => "receipt")).rejects.toBeInstanceOf(PostgresCommitUncertainError);
    expect(f.connections()).toBe(1);
    expect(f.releases[0]).toBeInstanceOf(Error);
  });

  it("preserves both failures and discards a client when rollback fails", async () => {
    const f = fixture("ROLLBACK");
    await expect(f.work.run(async () => { throw new Error("operation failed"); })).rejects.toBeInstanceOf(AggregateError);
    expect(f.releases[0]).toBeInstanceOf(Error);
  });

  it("requires explicit bounded timeout values", () => {
    expect(() => createPostgresUnitOfWork({ async connect() { throw new Error("unused"); } }, { ...options, statementTimeoutMs: 0 })).toThrow("timeouts");
  });
});
