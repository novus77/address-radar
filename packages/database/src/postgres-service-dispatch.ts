import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, open, opendir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

export const POSTGRES_BUSINESS_SERVICES = Object.freeze([
  "scanner", "automation", "wallet-monitor", "wallet-analysis", "historical-backfill", "console",
] as const);
export type PostgresBusinessService = typeof POSTGRES_BUSINESS_SERVICES[number];
export type ServiceEnvironment = Readonly<Record<string, string | undefined>>;
export type PostgresExecutionFormat = "tsx" | "compiled-esm";
export interface PostgresDispatchBudgets {
  startupMs: number;
  pollMs: number;
  shutdownMs: number;
  killMs: number;
}
export interface PostgresReleaseLimits { maximumEntries: number; maximumBytes: number }
export interface PostgresServiceLifecycleIdentity {
  service: PostgresBusinessService;
  operationId: string;
  generationId: string;
  releaseSha256: string;
  nonce: string;
}
export interface PostgresServiceLifecycleNotice extends PostgresServiceLifecycleIdentity {
  type: "postgres-service-ready" | "postgres-service-drained";
}

export function selectAddressRadarBackend(env: ServiceEnvironment): "sqlite" | "postgresql" {
  const marked = Object.keys(env).some(key => key.startsWith("ADDRESS_RADAR_POSTGRES_") && env[key] !== undefined);
  const selected = env.ADDRESS_RADAR_DATABASE_BACKEND;
  if (marked && selected !== "postgresql") throw new Error("PostgreSQL markers require an explicit PostgreSQL backend selector");
  const backend = selected ?? "sqlite";
  if (backend !== "sqlite" && backend !== "postgresql") throw new Error("Unsupported Address Radar database backend");
  return backend;
}

/** Execution format is pinned deployment material, never inferred from available files. */
export function readPostgresExecutionFormat(deployment: { readonly executionFormat?: unknown; readonly cutover?: unknown },
  env: ServiceEnvironment): PostgresExecutionFormat {
  const declared = deployment.executionFormat, configured = env.ADDRESS_RADAR_POSTGRES_EXECUTION_FORMAT;
  if (declared === undefined && configured === undefined) return "tsx";
  if ((declared !== "tsx" && declared !== "compiled-esm") || declared !== configured) {
    throw new Error("PostgreSQL execution format must be known and match deployment and environment");
  }
  if (declared === "compiled-esm") {
    const cutover = deployment.cutover;
    if (!cutover || typeof cutover !== "object" || Array.isArray(cutover)
      || Object.keys(cutover).length !== 1 || !Object.hasOwn(cutover, "addressOnly")) {
      throw new Error("Compiled PostgreSQL execution requires the dedicated address-only protocol");
    }
    const manifest = (cutover as Record<string, unknown>).addressOnly;
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)
      || (manifest as Record<string, unknown>).protocol !== "address-only-v1") {
      throw new Error("Compiled PostgreSQL execution requires the dedicated address-only protocol");
    }
  }
  return declared;
}

export function readPostgresServiceBudgets(env: ServiceEnvironment): PostgresDispatchBudgets {
  const read = (name: string) => {
    const text = env[name];
    if (typeof text !== "string" || !/^[1-9][0-9]{0,4}$/.test(text) || Number(text) > 60_000) {
      throw new Error("Explicit bounded PostgreSQL lifecycle budgets required");
    }
    return Number(text);
  };
  return { startupMs: read("ADDRESS_RADAR_POSTGRES_STARTUP_MS"), pollMs: read("ADDRESS_RADAR_POSTGRES_POLL_MS"),
    shutdownMs: read("ADDRESS_RADAR_POSTGRES_SHUTDOWN_MS"), killMs: read("ADDRESS_RADAR_POSTGRES_KILL_MS") };
}

/** A timeout does not cancel an ignored operation or acknowledge its eventual completion. */
export function withPostgresDeadline<T>(operation: () => Promise<T>, options: {
  maximumMs: number; signal?: AbortSignal; pending?: Set<Promise<unknown>>;
  onTimeout?: () => void; onWorkRejected?: () => void;
}): Promise<T> {
  if (!Number.isSafeInteger(options.maximumMs) || options.maximumMs < 1 || options.maximumMs > 60_000) {
    return Promise.reject(new Error("Explicit bounded PostgreSQL operation budget required"));
  }
  const started = performance.now();
  if (options.signal?.aborted) return Promise.reject(new Error("POSTGRES_OPERATION_ABORTED"));
  const work = Promise.resolve().then(() => {
    if (options.signal?.aborted) throw new Error("POSTGRES_OPERATION_ABORTED");
    return operation();
  });
  options.pending?.add(work);
  void work.then(() => options.pending?.delete(work), () => {
    options.pending?.delete(work); options.onWorkRejected?.();
  });
  return new Promise<T>((resolve_, reject) => {
    let settled = false;
    const finish = (error: Error | null, value?: T) => {
      if (settled) return;
      settled = true; clearTimeout(timer); options.signal?.removeEventListener("abort", abort);
      if (error) reject(error); else resolve_(value as T);
    };
    const abort = () => finish(new Error("POSTGRES_OPERATION_ABORTED"));
    const timer = setTimeout(() => {
      if (settled) return;
      finish(new Error("POSTGRES_OPERATION_DEADLINE_EXCEEDED")); options.onTimeout?.();
    }, options.maximumMs);
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    void work.then(value => {
      if (settled) return;
      if (performance.now() - started >= options.maximumMs) {
        finish(new Error("POSTGRES_OPERATION_DEADLINE_EXCEEDED")); options.onTimeout?.();
      } else if (options.signal?.aborted) abort(); else finish(null, value);
    }, error => finish(error instanceof Error ? error : new Error("POSTGRES_OPERATION_FAILED")));
  });
}

export function assertPostgresServiceSafety(env: ServiceEnvironment): void {
  if (selectAddressRadarBackend(env) !== "postgresql") throw new Error("Explicit PostgreSQL backend required");
  if (env.ADDRESS_RADAR_GATEWAY_DELIVERY_ENABLED !== "false") throw new Error("PostgreSQL preparation requires delivery explicitly disabled");
  for (const name of ["ADDRESS_RADAR_FOMO_BROWSER_ENABLED", "ADDRESS_RADAR_FOMO_CAPTURE_ENABLED", "ADDRESS_RADAR_FULL_HISTORICAL_MINING_ENABLED"]) {
    if (env[name] !== undefined && env[name] !== "false") throw new Error("Deferred input channel must remain disabled");
  }
  for (const name of ["ADDRESS_RADAR_POSTGRES_DEPLOYMENT_SHA256", "ADDRESS_RADAR_POSTGRES_ENTRY_SHA256", "ADDRESS_RADAR_POSTGRES_RELEASE_SHA256"]) {
    if (!/^[a-f0-9]{64}$/.test(env[name] ?? "")) throw new Error("Externally pinned deployment, entry and release digests required");
  }
  if (!env.ADDRESS_RADAR_POSTGRES_URL?.trim()) throw new Error("Explicit PostgreSQL credentials required");
  const format = env.ADDRESS_RADAR_POSTGRES_EXECUTION_FORMAT;
  if (format !== undefined && format !== "tsx" && format !== "compiled-esm") throw new Error("Unknown PostgreSQL execution format");
  if (Object.keys(env).some(key => (key.startsWith("TSX_") && key !== "TSX_DISABLE_CACHE"
      || ["NODE_OPTIONS", "NODE_PATH", "NODE_COMPILE_CACHE"].includes(key)) && env[key] !== undefined)) {
    throw new Error("External PostgreSQL loader configuration refused");
  }
  readPostgresServiceBudgets(env);
}

/** Pin deployment material. These bytes supply expectations, never permission to start a writer. */
export async function readPrivatePostgresDeployment(env: ServiceEnvironment): Promise<Record<string, unknown>> {
  assertPostgresServiceSafety(env);
  const path = env.ADDRESS_RADAR_POSTGRES_DEPLOYMENT_FILE;
  if (!path || !isAbsolute(path)) throw new Error("Absolute PostgreSQL deployment file required");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat({ bigint: true });
    const uid = BigInt(process.getuid?.() ?? -1);
    if (!before.isFile() || before.size > 512n * 1024n || before.nlink !== 1n
      || (before.mode & 0o077n) !== 0n || (before.uid !== 0n && before.uid !== uid)) throw new Error("Unsafe PostgreSQL deployment file");
    const body = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.ctimeNs !== after.ctimeNs || before.mtimeNs !== after.mtimeNs || body.length !== Number(before.size)
      || createHash("sha256").update(body).digest("hex") !== env.ADDRESS_RADAR_POSTGRES_DEPLOYMENT_SHA256) {
      throw new Error("PostgreSQL deployment identity changed");
    }
    const value: unknown = JSON.parse(body.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid PostgreSQL deployment material");
    const deployment = value as Record<string, unknown>;
    if (deployment.format !== 1 || typeof deployment.operationId !== "string"
      || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(deployment.operationId)
      || typeof deployment.releaseRoot !== "string" || !isAbsolute(deployment.releaseRoot)
      || typeof deployment.generationId !== "string" || !deployment.generationId.trim()
      || deployment.gatewayDeliveryEnabled !== false || deployment.fomoEnabled !== false
      || deployment.fullHistoricalMiningEnabled !== false) throw new Error("Incomplete PostgreSQL deployment boundary");
    readPostgresExecutionFormat(deployment, env);
    return deployment;
  } finally { await handle.close(); }
}

/** The privileged release owner is the trust boundary; the service must be unable to mutate it. */
async function assertNotServiceWritable(path: string): Promise<void> {
  let writable = false;
  try { await access(path, constants.W_OK); writable = true; }
  catch (error) { if (!["EACCES", "EPERM", "EROFS"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
  if (writable) throw new Error("Service-writable PostgreSQL execution path refused");
}

export async function assertProtectedPostgresPath(path: string): Promise<void> {
  if (!process.geteuid || process.geteuid() === 0 || !isAbsolute(path) || resolve(path) !== path || await realpath(path) !== path) {
    throw new Error("Unsafe PostgreSQL execution path or privileged service identity");
  }
  let cursor = path;
  for (;;) {
    const stat = await lstat(cursor);
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()) || stat.uid !== 0 || (stat.mode & 0o022) !== 0) {
      throw new Error("Unsafe PostgreSQL execution ownership or parent path");
    }
    await assertNotServiceWritable(cursor);
    const parent = dirname(cursor); if (parent === cursor) break; cursor = parent;
  }
}

/** Hash the entire sealed import closure, including the in-process loader. Never chmod/chown here. */
export async function verifyPostgresServiceRelease(deployment: { releaseRoot: string; execution: PostgresReleaseLimits;
  executionFormat?: PostgresExecutionFormat; cutover?: unknown },
  env: ServiceEnvironment, signal?: AbortSignal): Promise<{ root: string; releaseSha256: string }> {
  assertPostgresServiceSafety(env);
  const format = readPostgresExecutionFormat(deployment, env);
  const entryPath = format === "compiled-esm" ? "scripts/postgres-service-entry.mjs" : "scripts/postgres-service-entry.ts";
  const { maximumEntries, maximumBytes } = deployment.execution ?? {};
  if (!Number.isSafeInteger(maximumEntries) || maximumEntries < 1 || !Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new Error("Explicit bounded release inventory required");
  }
  const root = deployment.releaseRoot;
  await assertProtectedPostgresPath(root);
  await assertProtectedPostgresPath(await realpath(process.execPath));
  // Node must not resolve missing dependencies in a mutable ancestor node_modules tree.
  for (let parent = dirname(root);;) {
    try { await lstat(join(parent, "node_modules")); throw new Error("Ambient PostgreSQL module resolution refused"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const next = dirname(parent); if (next === parent) break; parent = next;
  }
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory()) throw new Error("PostgreSQL release root must be a directory");
  const hash = createHash("sha256");
  let entries = 0, bytes = 0, entrySeen = false, launcherSeen = false, loaderSeen = false, configSeen = false;
  const walk = async (path: string): Promise<void> => {
    if (signal?.aborted) throw new Error("POSTGRES_OPERATION_ABORTED");
    if (++entries > maximumEntries) throw new Error("PostgreSQL release entry budget exceeded");
    const stat = await lstat(path, { bigint: true });
    if (stat.isSymbolicLink() || stat.uid !== 0n || (stat.mode & 0o222n) !== 0n || stat.dev !== BigInt(rootStat.dev)
      || (!stat.isDirectory() && !stat.isFile())) throw new Error("Unsealed PostgreSQL release entry refused");
    await assertNotServiceWritable(path);
    const name = relative(root, path).split("\\").join("/") || ".";
    if (stat.isDirectory()) {
      hash.update(JSON.stringify({ path: name, mode: Number(stat.mode & 0o777n), kind: "directory" }) + "\n");
      const children: string[] = [];
      for await (const child of await opendir(path)) {
        if (signal?.aborted) throw new Error("POSTGRES_OPERATION_ABORTED");
        if (children.length >= maximumEntries - entries) throw new Error("PostgreSQL release entry budget exceeded");
        children.push(child.name);
      }
      for (const child of children.sort()) await walk(join(path, child));
      return;
    }
    if (stat.nlink !== 1n || stat.size > BigInt(maximumBytes - bytes)) throw new Error("PostgreSQL release file budget or link identity refused");
    bytes += Number(stat.size);
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await handle.stat({ bigint: true });
      const content = await handle.readFile();
      const after = await handle.stat({ bigint: true });
      if (before.dev !== stat.dev || before.ino !== stat.ino || before.uid !== stat.uid || before.mode !== stat.mode
        || before.size !== stat.size || before.nlink !== 1n || after.ctimeNs !== before.ctimeNs
        || after.mtimeNs !== before.mtimeNs || after.size !== before.size || content.length !== Number(before.size)) {
        throw new Error("PostgreSQL sealed release identity changed");
      }
      const sha256 = createHash("sha256").update(content).digest("hex");
      hash.update(JSON.stringify({ path: name, mode: Number(stat.mode & 0o777n), kind: "file", size: content.length, sha256 }) + "\n");
      if (name === entryPath) {
        entrySeen = true;
        if (sha256 !== env.ADDRESS_RADAR_POSTGRES_ENTRY_SHA256) throw new Error("PostgreSQL service entry digest mismatch");
      }
      if (name === "node_modules/tsx/dist/cli.mjs") launcherSeen = true;
      if (name === "node_modules/tsx/dist/loader.mjs") loaderSeen = true;
      if (name === "tsconfig.json") configSeen = true;
    } finally { await handle.close(); }
  };
  await walk(root);
  const releaseSha256 = hash.digest("hex");
  if (!entrySeen || (format === "tsx" && (!launcherSeen || !loaderSeen || !configSeen))
    || releaseSha256 !== env.ADDRESS_RADAR_POSTGRES_RELEASE_SHA256) {
    throw new Error("Complete PostgreSQL release identity required");
  }
  return { root, releaseSha256 };
}

interface DispatchDependencies {
  readonly spawn?: (executable: string, arguments_: readonly string[], env: ServiceEnvironment) => ChildProcess;
  readonly signalEmitter?: Pick<NodeJS.Process, "once" | "removeListener">;
}

/** The sealed working directory supplies tsconfig; no CLI intermediary owns the worker IPC. */
export function postgresServiceChildArguments(root: string, service: PostgresBusinessService,
  format: PostgresExecutionFormat = "tsx"): readonly string[] {
  if (!isAbsolute(root) || resolve(root) !== root || !POSTGRES_BUSINESS_SERVICES.includes(service)) {
    throw new Error("Canonical PostgreSQL release root and service required");
  }
  if (format !== "tsx" && format !== "compiled-esm") throw new Error("Unknown PostgreSQL execution format");
  if (format === "compiled-esm") return ["--no-global-search-paths", join(root, "scripts", "postgres-service-entry.mjs"), service];
  return ["--no-global-search-paths", "--import", pathToFileURL(join(root, "node_modules", "tsx", "dist", "loader.mjs")).href,
    join(root, "scripts", "postgres-service-entry.ts"), service];
}

/** IPC is lifecycle acknowledgement by the sealed child, not cutover or business write authority. */
export async function supervisePostgresServiceChild(child: ChildProcess, options: {
  identity: PostgresServiceLifecycleIdentity; budgets: PostgresDispatchBudgets;
  signalEmitter?: Pick<NodeJS.Process, "once" | "removeListener">;
}): Promise<void> {
  for (const value of Object.values(options.budgets)) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 60_000) throw new Error("Explicit bounded child budgets required");
  }
  const emitter = options.signalEmitter ?? process;
  await new Promise<void>((resolve_, reject) => {
    let settled = false, ready = false, drained = false, stopping = false;
    let failure: Error | undefined, shutdownTimer: ReturnType<typeof setTimeout> | undefined, killTimer: ReturnType<typeof setTimeout> | undefined;
    const matches = (message: unknown): message is PostgresServiceLifecycleNotice => {
      if (!message || typeof message !== "object" || Array.isArray(message)) return false;
      const value = message as Record<string, unknown>;
      return Object.keys(value).length === Object.keys(options.identity).length + 1
        && Object.entries(options.identity).every(([key, expected]) => value[key] === expected);
    };
    const cleanup = () => {
      clearTimeout(startupTimer); clearTimeout(shutdownTimer); clearTimeout(killTimer);
      emitter.removeListener("SIGINT", stop); emitter.removeListener("SIGTERM", stop);
      child.removeListener("message", message); child.removeListener("error", error); child.removeListener("exit", exit);
    };
    const finish = () => {
      if (settled) return; settled = true; cleanup();
      if (failure) reject(failure); else resolve_();
    };
    const kill = (signal: NodeJS.Signals) => {
      try { if (!child.kill(signal)) failure ??= new Error("PostgreSQL child termination was not confirmed"); }
      catch { failure ??= new Error("PostgreSQL child termination failed"); }
    };
    const stop = () => {
      if (settled || stopping) return;
      stopping = true; clearTimeout(startupTimer); kill("SIGTERM");
      shutdownTimer = setTimeout(() => {
        failure ??= new Error("PostgreSQL shutdown drain deadline exceeded"); kill("SIGKILL");
        killTimer = setTimeout(() => {
          failure ??= new Error("PostgreSQL child exit deadline exceeded");
          if (child.connected) child.disconnect(); child.unref(); finish();
        }, options.budgets.killMs);
      }, options.budgets.shutdownMs);
    };
    const startupTimer = setTimeout(() => { failure ??= new Error("PostgreSQL startup deadline exceeded"); stop(); }, options.budgets.startupMs);
    const message = (value: unknown) => {
      if (settled || failure || !matches(value)) return;
      if (value.type === "postgres-service-ready" && !stopping && !ready) { ready = true; clearTimeout(startupTimer); }
      else if (value.type === "postgres-service-drained" && stopping && ready) drained = true;
    };
    const error = () => { failure ??= new Error("PostgreSQL service launch failed"); stop(); };
    const exit = (code: number | null, signal: NodeJS.Signals | null) => {
      if (code !== 0 || signal !== null || !ready || !stopping || !drained) failure ??= new Error("PostgreSQL service exited without a successful shutdown drain");
      finish();
    };
    emitter.once("SIGINT", stop); emitter.once("SIGTERM", stop);
    child.on("message", message); child.once("error", error); child.once("exit", exit);
    if (child.exitCode !== null || child.signalCode !== null) exit(child.exitCode, child.signalCode);
  });
}

/** Compatibility launcher only. It never migrates, grants cutover authority, or opens SQLite. */
export async function dispatchPostgresBusinessService(service: PostgresBusinessService, env: ServiceEnvironment = process.env,
  dependencies: DispatchDependencies = {}): Promise<boolean> {
  if (!POSTGRES_BUSINESS_SERVICES.includes(service)) throw new Error("Unknown PostgreSQL business service");
  if (selectAddressRadarBackend(env) === "sqlite") return false;
  const budgets = readPostgresServiceBudgets(env), started = performance.now();
  const controller = new AbortController();
  const deployment = await withPostgresDeadline(() => readPrivatePostgresDeployment(env), {
    maximumMs: budgets.startupMs, signal: controller.signal, onTimeout: () => controller.abort(),
  });
  const format = readPostgresExecutionFormat(deployment, env);
  const lifecycle = deployment.lifecycle as Record<string, unknown> | undefined;
  if (!lifecycle || Array.isArray(lifecycle) || Object.keys(lifecycle).length !== 4
    || Object.entries(budgets).some(([key, value]) => lifecycle[key] !== value)) throw new Error("Pinned PostgreSQL lifecycle allocation mismatch");
  const remaining = () => Math.floor(budgets.startupMs - (performance.now() - started));
  const sealed = await withPostgresDeadline(() => verifyPostgresServiceRelease(
    deployment as unknown as Parameters<typeof verifyPostgresServiceRelease>[0], env, controller.signal),
  { maximumMs: remaining(), signal: controller.signal, onTimeout: () => controller.abort() });
  const identity: PostgresServiceLifecycleIdentity = { service, operationId: deployment.operationId as string,
    generationId: deployment.generationId as string, releaseSha256: sealed.releaseSha256, nonce: randomBytes(16).toString("hex") };
  const environment = { ...env, ...(format === "tsx" ? { TSX_DISABLE_CACHE: "1" } : {}),
    NODE_DISABLE_COMPILE_CACHE: "1", ADDRESS_RADAR_POSTGRES_LAUNCH_NONCE: identity.nonce };
  const start = dependencies.spawn ?? ((executable, arguments_, environment_) => spawn(executable, [...arguments_], {
    env: { ...environment_ }, cwd: sealed.root, stdio: ["inherit", "inherit", "inherit", "ipc"], shell: false,
  }));
  const executable = await realpath(process.execPath), startupMs = remaining();
  if (startupMs < 1) throw new Error("PostgreSQL startup deadline exceeded");
  const child = start(executable, postgresServiceChildArguments(sealed.root, service, format), environment);
  await supervisePostgresServiceChild(child, { identity, budgets: { ...budgets, startupMs },
    ...(dependencies.signalEmitter ? { signalEmitter: dependencies.signalEmitter } : {}) });
  return true;
}
