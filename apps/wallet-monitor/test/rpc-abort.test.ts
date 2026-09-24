import assert from "node:assert/strict";
import { test } from "vitest";

import { createConfiguredWalletRpcClient } from "../src/index.js";

test("wallet monitor RPC composition aborts in-flight fetch on shutdown", async () => {
  const client = createConfiguredWalletRpcClient({
    endpoints: { solana: { primary: "https://solana.invalid", fallback: "https://fallback.invalid" } },
    fetch: async (_url, init) => await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }),
  });
  const controller = new AbortController();
  const pending = client.request("solana", "getHealth", [], controller.signal);
  controller.abort();

  await assert.rejects(pending, { name: "JsonRpcAbortError" });
});
