import assert from "node:assert/strict";
import { test } from "vitest";

import { createConfiguredAnalysisRpcClient } from "../src/index.js";

test("wallet analysis RPC composition aborts in-flight fetch on shutdown", async () => {
  const client = createConfiguredAnalysisRpcClient({
    endpoints: { base: { primary: "https://base.invalid", fallback: "https://fallback.invalid" } },
    fetch: async (_url, init) => await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }),
  });
  const controller = new AbortController();
  const pending = client.request("base", "eth_blockNumber", [], controller.signal);
  controller.abort();

  await assert.rejects(pending, { name: "JsonRpcAbortError" });
});
