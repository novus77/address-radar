import { openAddressRadarRepository } from "@address-radar/database";
import { pathToFileURL } from "node:url";
import { parseScannerConfig, runScannerPreflight } from "./config.js";
import { createPollingRuntimeJob, createScannerRuntime } from "./runtime.js";

export async function main(env: Readonly<Record<string, string | undefined>> = process.env): Promise<void> {
  const config = parseScannerConfig(env);
  const preflight = await runScannerPreflight({ config });
  if (!preflight.ready) throw new Error(preflight.failures.map(item => `${item.code}: ${item.message}`).join("; "));

  const repository = openAddressRadarRepository(config.databasePath);
  const runtime = createScannerRuntime({
    repository,
    collectors: [],
    signalSink: { accept: () => undefined },
    clock: { now: Date.now },
    config,
  });
  const polling = createPollingRuntimeJob({
    runOnce: () => runtime.runOnce(),
    intervalMs: config.pollIntervalMs,
    onError: error => console.error("Scanner iteration failed", error),
  });

  await runtime.start();
  polling.start();
  const shutdown = async (): Promise<void> => {
    await polling.stop();
    await runtime.close();
    repository.close();
  };
  process.once("SIGINT", () => { void shutdown(); });
  process.once("SIGTERM", () => { void shutdown(); });
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  void main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
