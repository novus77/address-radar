import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { runWalletMonitorService } from "../src/index.js";

test("monitor sleep removes its abort listener after timeout", async () => {
  const controller = new AbortController();
  const remove = vi.spyOn(controller.signal, "removeEventListener");
  let calls = 0;
  await runWalletMonitorService({
    signal: controller.signal,
    intervalMs: 0,
    pollOnce: async () => {
      calls += 1;
      if (calls === 2) controller.abort();
    },
  });
  assert.ok(remove.mock.calls.some(([type]) => type === "abort"));
});
