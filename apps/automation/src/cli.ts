import { hostname } from "node:os";

import { loadAutomationConfig } from "./config.js";
import { createAutomationRuntime } from "./runtime.js";
import { runAutomationService } from "./service.js";

const config = loadAutomationConfig(process.env);
const runtime = createAutomationRuntime({
  config,
  handlers: [],
  workerId: `automation:${hostname()}:${process.pid}`,
});
const controller = new AbortController();
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  controller.abort();
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);

try {
  await runAutomationService({
    signal: controller.signal,
    intervalMs: config.intervalMs,
    pollOnce: () => runtime.pollOnce(controller.signal),
    onError: (error) => console.error(`[automation] ${error.message}`),
  });
} finally {
  runtime.close();
}
