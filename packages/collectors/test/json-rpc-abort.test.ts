import assert from "node:assert/strict";
import { test } from "vitest";

import {
  JsonRpcAbortError,
  createJsonRpcClient,
} from "../src/index.js";

test("external abort stops an in-flight request without trying fallback", async () => {
  const requests: string[] = [];
  const client = createJsonRpcClient({
    endpoint: "https://primary.invalid",
    fallbackEndpoint: "https://fallback.invalid",
    timeoutMs: 10_000,
    fetch: async (url, init) => {
      requests.push(String(url));
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        }, { once: true });
      });
    },
  });
  const controller = new AbortController();

  const pending = client.request("eth_blockNumber", [], controller.signal);
  controller.abort();

  await assert.rejects(pending, JsonRpcAbortError);
  assert.deepEqual(requests, ["https://primary.invalid"]);
});

test("internal timeout remains eligible for fallback", async () => {
  const requests: string[] = [];
  const client = createJsonRpcClient({
    endpoint: "https://primary.invalid",
    fallbackEndpoint: "https://fallback.invalid",
    timeoutMs: 5,
    fetch: async (url, init) => {
      requests.push(String(url));
      if (String(url).includes("fallback")) {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x2a" }));
      }
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("timeout", "AbortError"));
        }, { once: true });
      });
    },
  });

  assert.equal(await client.request("eth_blockNumber", []), "0x2a");
  assert.deepEqual(requests, ["https://primary.invalid", "https://fallback.invalid"]);
});
