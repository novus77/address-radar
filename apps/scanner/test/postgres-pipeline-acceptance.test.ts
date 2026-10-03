import { describe, expect, it, vi } from "vitest";
import type { PostgresAcceptanceRuntime } from "@address-radar/database";
import * as pipeline from "../src/postgres-pipeline-acceptance.js";

const verify = (runtime: Pick<PostgresAcceptanceRuntime, "probe" | "run">, now: number) =>
  (pipeline as unknown as { verifyPostgresPipelineAcceptance: (runtime: Pick<PostgresAcceptanceRuntime, "probe" | "run">, now: number) => Promise<unknown> })
    .verifyPostgresPipelineAcceptance(runtime, now);

describe("PostgreSQL pipeline acceptance entry point", () => {
  it("exports an explicit isolated pipeline verifier", () => {
    expect((pipeline as Record<string, unknown>).verifyPostgresPipelineAcceptance).toBeTypeOf("function");
  });

  it("rejects invalid fixture clocks before acquiring a connection", async () => {
    const runtime = { probe: vi.fn(), run: vi.fn() } as unknown as Pick<PostgresAcceptanceRuntime, "probe" | "run">;
    for (const now of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER]) {
      await expect(verify(runtime, now)).rejects.toThrow("acceptance timestamp");
    }
    expect(runtime.probe).not.toHaveBeenCalled();
    expect(runtime.run).not.toHaveBeenCalled();
  });
});
