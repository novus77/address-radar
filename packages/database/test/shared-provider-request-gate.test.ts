import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSharedProviderRequestGate } from "../src/shared-provider-request-gate.js";

afterEach(() => vi.useRealTimers());

describe("shared provider request gate", () => {
  it("serializes requests from independent database connections", async () => {
    vi.useFakeTimers();
    const path = join(mkdtempSync(join(tmpdir(), "shared-gate-")), "radar.db");
    const firstDb = new DatabaseSync(path), secondDb = new DatabaseSync(path);
    const first = createSharedProviderRequestGate({ database: firstDb, provider: "gecko", minimumIntervalMs: 1000 });
    const second = createSharedProviderRequestGate({ database: secondDb, provider: "gecko", minimumIntervalMs: 1000 });
    await first.acquire();
    let acquired = false;
    const pending = second.acquire().then(() => { acquired = true; });
    await vi.advanceTimersByTimeAsync(999);
    expect(acquired).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    firstDb.close(); secondDb.close();
  });

  it("shares cooldown across clients and cancels waiting requests", async () => {
    vi.useFakeTimers();
    const db = new DatabaseSync(":memory:");
    const first = createSharedProviderRequestGate({ database: db, provider: "gecko", minimumIntervalMs: 1000 });
    const second = createSharedProviderRequestGate({ database: db, provider: "gecko", minimumIntervalMs: 1000 });
    first.cooldown(5000);
    const controller = new AbortController();
    const cancelled = second.acquire(controller.signal);
    const assertion = expect(cancelled).rejects.toThrow();
    controller.abort(); await assertion;
    let acquired = false;
    const pending = second.acquire().then(() => { acquired = true; });
    await vi.advanceTimersByTimeAsync(4999); expect(acquired).toBe(false);
    await vi.advanceTimersByTimeAsync(1); await pending;
    db.close();
  });
});
