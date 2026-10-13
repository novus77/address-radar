import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmodSync, mkdtempSync, mkdirSync, realpathSync, symlinkSync, writeFileSync,
  readdirSync, readFileSync, statSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { assertPostgresServiceSafety, assertProtectedPostgresPath, dispatchPostgresBusinessService, POSTGRES_BUSINESS_SERVICES,
  readPrivatePostgresDeployment, readPostgresServiceBudgets, selectAddressRadarBackend, supervisePostgresServiceChild,
  verifyPostgresServiceRelease, withPostgresDeadline, postgresServiceChildArguments, readPostgresExecutionFormat,
  type PostgresServiceLifecycleIdentity } from "../src/postgres-service-dispatch.js";

const digest = (body: string) => createHash("sha256").update(body).digest("hex");
const budgets = { startupMs: 2000, pollMs: 1000, shutdownMs: 200, killMs: 200 };
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "radar-pg-dispatch-")));
  mkdirSync(join(root, "scripts"));
  const entry = "// Isolated launcher fixture.\n";
  writeFileSync(join(root, "scripts", "postgres-service-entry.ts"), entry);
  const path = join(root, "deployment.json");
  const deployment = { format: 1, operationId: "isolated-launcher", releaseRoot: root, generationId: "fixture-generation",
    lifecycle: budgets, execution: { maximumEntries: 20, maximumBytes: 4096 },
    gatewayDeliveryEnabled: false, fomoEnabled: false, fullHistoricalMiningEnabled: false };
  const body = JSON.stringify(deployment);
  writeFileSync(path, body, { mode: 0o600 });
  const env = { ADDRESS_RADAR_DATABASE_BACKEND: "postgresql", ADDRESS_RADAR_GATEWAY_DELIVERY_ENABLED: "false",
    ADDRESS_RADAR_POSTGRES_URL: "postgresql://fixture:never-logged@127.0.0.1/fixture",
    ADDRESS_RADAR_POSTGRES_DEPLOYMENT_FILE: path, ADDRESS_RADAR_POSTGRES_DEPLOYMENT_SHA256: digest(body),
    ADDRESS_RADAR_POSTGRES_ENTRY_SHA256: digest(entry), ADDRESS_RADAR_POSTGRES_RELEASE_SHA256: digest("unproved"),
    ADDRESS_RADAR_POSTGRES_STARTUP_MS: "2000", ADDRESS_RADAR_POSTGRES_POLL_MS: "1000",
    ADDRESS_RADAR_POSTGRES_SHUTDOWN_MS: "200", ADDRESS_RADAR_POSTGRES_KILL_MS: "200" };
  return { root, path, env, deployment };
}
const identity: PostgresServiceLifecycleIdentity = { service: "console", operationId: "isolated-launcher",
  generationId: "fixture-generation", releaseSha256: digest("isolated"), nonce: "0".repeat(32) };
const notice = (type: "postgres-service-ready" | "postgres-service-drained") => ({ ...identity, type });
function childFixture() {
  const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null, connected: false,
    kill: vi.fn(() => true), unref: vi.fn(), disconnect: vi.fn() });
  return { child, typed: child as unknown as ChildProcess, emitter: new EventEmitter() };
}

function compiledFixture() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "radar-compiled-release-")));
  const root = join(directory, "release");
  mkdirSync(root); mkdirSync(join(root, "scripts")); mkdirSync(join(root, "lib"));
  const entry = "import { value } from '../lib/value.mjs'; process.send?.({ pid: process.pid, service: process.argv[2], value }, () => process.exit(0));\n";
  writeFileSync(join(root, "scripts", "postgres-service-entry.mjs"), entry);
  writeFileSync(join(root, "lib", "value.mjs"), "export const value = 42;\n");
  const deployment = { format: 1, operationId: "isolated-compiled", generationId: "fixture-generation", releaseRoot: root,
    executionFormat: "compiled-esm" as const, execution: { maximumEntries: 20, maximumBytes: 4096 }, lifecycle: budgets,
    cutover: { addressOnly: { protocol: "address-only-v1" } },
    gatewayDeliveryEnabled: false, fomoEnabled: false, fullHistoricalMiningEnabled: false };
  const body = JSON.stringify(deployment), path = join(directory, "deployment.json");
  writeFileSync(path, body, { mode: 0o600 });
  const env = { ...fixture().env, ADDRESS_RADAR_POSTGRES_DEPLOYMENT_FILE: path,
    ADDRESS_RADAR_POSTGRES_DEPLOYMENT_SHA256: digest(body), ADDRESS_RADAR_POSTGRES_ENTRY_SHA256: digest(entry),
    ADDRESS_RADAR_POSTGRES_EXECUTION_FORMAT: "compiled-esm" };
  const inventoryDigest = () => {
    const hash = createHash("sha256");
    const walk = (path_: string) => {
      const metadata = statSync(path_), name = relative(root, path_).split("\\").join("/") || ".";
      const mode = metadata.mode & 0o555;
      if (metadata.isDirectory()) {
        hash.update(JSON.stringify({ path: name, mode, kind: "directory" }) + "\n");
        for (const child of readdirSync(path_).sort()) walk(join(path_, child));
      } else {
        const content = readFileSync(path_);
        hash.update(JSON.stringify({ path: name, mode, kind: "file", size: content.length,
          sha256: createHash("sha256").update(content).digest("hex") }) + "\n");
      }
    };
    walk(root);
    return hash.digest("hex");
  };
  return { root, deployment, env, inventoryDigest };
}

/** Only privileged ownership/DAC metadata is simulated; inventory bytes and paths use real files. */
async function withSealedFilesystem(test: (dispatch: typeof import("../src/postgres-service-dispatch.js")) => Promise<void>) {
  vi.resetModules();
  vi.doMock("node:fs/promises", async importOriginal => {
    const fs = await importOriginal<typeof import("node:fs/promises")>();
    const sealed = <T extends { uid: number | bigint; mode: number | bigint }>(stat: T): T => Object.assign(Object.create(stat), {
      uid: typeof stat.uid === "bigint" ? 0n : 0,
      mode: typeof stat.mode === "bigint" ? stat.mode & ~0o222n : stat.mode & ~0o222,
    });
    return { ...fs,
      access: async () => { throw Object.assign(new Error("Simulated protected DAC"), { code: "EACCES" }); },
      lstat: async (...args: Parameters<typeof fs.lstat>) => sealed(await fs.lstat(...args)),
      open: async (...args: Parameters<typeof fs.open>) => {
        const handle = await fs.open(...args);
        return { stat: async (...options: Parameters<typeof handle.stat>) => sealed(await handle.stat(...options)),
          readFile: handle.readFile.bind(handle), close: handle.close.bind(handle) };
      },
    };
  });
  const uid = vi.spyOn(process, "geteuid").mockReturnValue(1001);
  try { await test(await import("../src/postgres-service-dispatch.js")); }
  finally { uid.mockRestore(); vi.doUnmock("node:fs/promises"); vi.resetModules(); }
}

describe("compiled ESM sealed execution", () => {
  it("executes a real .mjs import and IPC without any TSX loader", async () => {
    const f = compiledFixture();
    const child = spawn(process.execPath, [...postgresServiceChildArguments(f.root, "console", "compiled-esm")], {
      cwd: f.root, env: { NODE_DISABLE_COMPILE_CACHE: "1" }, stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    const result = await new Promise<{ message: unknown; code: number | null }>((resolve, reject) => {
      let message: unknown;
      const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Compiled child deadline exceeded")); }, 2000);
      child.on("message", value => { message = value; });
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("exit", code => { clearTimeout(timer); resolve({ message, code }); });
    });
    expect(result).toEqual({ message: { pid: child.pid, service: "console", value: 42 }, code: 0 });
  });
  it("accepts the complete pinned compiled closure with no TSX or tsconfig files", async () => {
    const f = compiledFixture(); f.env.ADDRESS_RADAR_POSTGRES_RELEASE_SHA256 = f.inventoryDigest();
    await withSealedFilesystem(async dispatch => {
      await expect(dispatch.verifyPostgresServiceRelease(f.deployment, f.env)).resolves.toEqual({
        root: f.root, releaseSha256: f.env.ADDRESS_RADAR_POSTGRES_RELEASE_SHA256,
      });
      await expect(dispatch.verifyPostgresServiceRelease(f.deployment, { ...f.env, ADDRESS_RADAR_POSTGRES_ENTRY_SHA256: digest("wrong") }))
        .rejects.toThrow("entry digest mismatch");
      await expect(dispatch.verifyPostgresServiceRelease(f.deployment, { ...f.env, ADDRESS_RADAR_POSTGRES_RELEASE_SHA256: digest("wrong") }))
        .rejects.toThrow("Complete");
      await expect(dispatch.verifyPostgresServiceRelease({ ...f.deployment, execution: { maximumEntries: 2, maximumBytes: 4096 } }, f.env))
        .rejects.toThrow("entry budget");
    });
  });
  it("still rejects non-entry dependency changes and added files against the external release pin", async () => {
    const f = compiledFixture(); f.env.ADDRESS_RADAR_POSTGRES_RELEASE_SHA256 = f.inventoryDigest();
    await withSealedFilesystem(async dispatch => {
      writeFileSync(join(f.root, "lib", "value.mjs"), "export const value = 43;\n");
      await expect(dispatch.verifyPostgresServiceRelease(f.deployment, f.env)).rejects.toThrow("Complete");
      writeFileSync(join(f.root, "lib", "value.mjs"), "export const value = 42;\n");
      writeFileSync(join(f.root, "unexpected.mjs"), "export const injected = true;\n");
      await expect(dispatch.verifyPostgresServiceRelease(f.deployment, f.env)).rejects.toThrow("Complete");
    });
  });
  it("refuses a missing compiled entry, symlinked dependency, and legacy closure without loaders", async () => {
    const f = compiledFixture();
    renameSync(join(f.root, "scripts", "postgres-service-entry.mjs"), join(f.root, "scripts", "postgres-service-entry.ts"));
    f.env.ADDRESS_RADAR_POSTGRES_RELEASE_SHA256 = f.inventoryDigest();
    await withSealedFilesystem(async dispatch => {
      await expect(dispatch.verifyPostgresServiceRelease(f.deployment, f.env)).rejects.toThrow("Complete");
      await expect(dispatch.verifyPostgresServiceRelease({ ...f.deployment, executionFormat: "tsx" },
        { ...f.env, ADDRESS_RADAR_POSTGRES_EXECUTION_FORMAT: "tsx" })).rejects.toThrow("Complete");
      symlinkSync(join(f.root, "lib", "value.mjs"), join(f.root, "lib", "alias.mjs"));
      await expect(dispatch.verifyPostgresServiceRelease(f.deployment, f.env)).rejects.toThrow("Unsealed");
    });
  });
  it("dispatches the compiled child with the verified format and retains lifecycle identity", async () => {
    const f = compiledFixture(); f.env.ADDRESS_RADAR_POSTGRES_RELEASE_SHA256 = f.inventoryDigest();
    await withSealedFilesystem(async dispatch => {
      const { child, typed, emitter } = childFixture();
      const start = vi.fn((_executable: string, _arguments: readonly string[], environment: Record<string, string | undefined>) => {
        setImmediate(() => {
          const bound = { service: "console", operationId: f.deployment.operationId, generationId: f.deployment.generationId,
            releaseSha256: f.env.ADDRESS_RADAR_POSTGRES_RELEASE_SHA256, nonce: environment.ADDRESS_RADAR_POSTGRES_LAUNCH_NONCE };
          child.emit("message", { ...bound, type: "postgres-service-ready" }); emitter.emit("SIGTERM");
          child.emit("message", { ...bound, type: "postgres-service-drained" }); child.emit("exit", 0, null);
        });
        return typed;
      });
      await expect(dispatch.dispatchPostgresBusinessService("console", f.env, { spawn: start, signalEmitter: emitter as never })).resolves.toBe(true);
      expect(start).toHaveBeenCalledTimes(1);
      expect(start.mock.calls[0]![1]).toEqual(["--no-global-search-paths", join(f.root, "scripts", "postgres-service-entry.mjs"), "console"]);
      expect(start.mock.calls[0]![2].TSX_DISABLE_CACHE).toBeUndefined();
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    });
  });
});

describe("PostgreSQL six-service backend dispatch", () => {
  it("defaults to legacy TSX and requires matching explicit address-only compiled execution", () => {
    expect(readPostgresExecutionFormat({}, {})).toBe("tsx");
    expect(readPostgresExecutionFormat({ executionFormat: "tsx" }, { ADDRESS_RADAR_POSTGRES_EXECUTION_FORMAT: "tsx" })).toBe("tsx");
    const compiled = { executionFormat: "compiled-esm", cutover: { addressOnly: { protocol: "address-only-v1" } } };
    expect(readPostgresExecutionFormat(compiled, { ADDRESS_RADAR_POSTGRES_EXECUTION_FORMAT: "compiled-esm" })).toBe("compiled-esm");
    for (const [deployment, env] of [
      [compiled, {}], [{}, { ADDRESS_RADAR_POSTGRES_EXECUTION_FORMAT: "compiled-esm" }],
      [compiled, { ADDRESS_RADAR_POSTGRES_EXECUTION_FORMAT: "tsx" }],
      [{ ...compiled, executionFormat: "unknown" }, { ADDRESS_RADAR_POSTGRES_EXECUTION_FORMAT: "unknown" }],
      [{ ...compiled, cutover: { expected: {} } }, { ADDRESS_RADAR_POSTGRES_EXECUTION_FORMAT: "compiled-esm" }],
      [{ ...compiled, cutover: { addressOnly: { protocol: "old" } } }, { ADDRESS_RADAR_POSTGRES_EXECUTION_FORMAT: "compiled-esm" }],
      [{ ...compiled, cutover: { addressOnly: { protocol: "address-only-v1" }, expected: {} } }, { ADDRESS_RADAR_POSTGRES_EXECUTION_FORMAT: "compiled-esm" }],
    ] as const) expect(() => readPostgresExecutionFormat(deployment, env)).toThrow();
  });
  it.each(POSTGRES_BUSINESS_SERVICES)("runs compiled %s directly with no TSX loader", service => {
    expect(postgresServiceChildArguments("/opt/sealed", service, "compiled-esm")).toEqual([
      "--no-global-search-paths", "/opt/sealed/scripts/postgres-service-entry.mjs", service,
    ]);
    expect(() => postgresServiceChildArguments("/opt/sealed", service, "unknown" as never)).toThrow();
  });
  it("rejects execution-format mismatch in pinned deployment before release inspection", async () => {
    const f = fixture();
    const body = JSON.stringify({ ...f.deployment, executionFormat: "compiled-esm",
      cutover: { addressOnly: { protocol: "address-only-v1" } } });
    writeFileSync(f.path, body);
    const env = { ...f.env, ADDRESS_RADAR_POSTGRES_DEPLOYMENT_SHA256: digest(body) };
    await expect(readPrivatePostgresDeployment(env)).rejects.toThrow("execution format");
    await expect(readPrivatePostgresDeployment({ ...env, ADDRESS_RADAR_POSTGRES_EXECUTION_FORMAT: "compiled-esm" }))
      .resolves.toMatchObject({ executionFormat: "compiled-esm" });
  });
  it.each(POSTGRES_BUSINESS_SERVICES)("loads %s directly without the tsx CLI intermediary", service => {
    const root = "/opt/sealed release#1";
    expect(postgresServiceChildArguments(root, service)).toEqual(["--no-global-search-paths", "--import",
      "file:///opt/sealed%20release%231/node_modules/tsx/dist/loader.mjs", root + "/scripts/postgres-service-entry.ts", service]);
    expect(() => postgresServiceChildArguments("relative", service)).toThrow("Canonical");
    expect(() => postgresServiceChildArguments("/opt/../mutable", service)).toThrow("Canonical");
  });
  it("keeps TypeScript execution and IPC in the directly spawned process", async () => {
    const root = fileURLToPath(new URL("../../../", import.meta.url));
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "radar-direct-loader-")));
    const entry = join(directory, "entry.ts");
    writeFileSync(entry, "const identity: { pid: number } = { pid: process.pid }; process.send?.(identity, () => process.exit(0));\n");
    const environment = { ...process.env, TSX_DISABLE_CACHE: "1", NODE_DISABLE_COMPILE_CACHE: "1" };
    for (const key of Object.keys(environment)) {
      if (["NODE_OPTIONS", "NODE_PATH", "NODE_COMPILE_CACHE", "TSX_TSCONFIG_PATH"].includes(key)) delete environment[key as keyof typeof environment];
    }
    const child = spawn(process.execPath, ["--no-global-search-paths", "--import",
      pathToFileURL(join(root, "node_modules", "tsx", "dist", "loader.mjs")).href, entry],
    { cwd: root, env: environment, stdio: ["ignore", "ignore", "ignore", "ipc"] });
    const result = await new Promise<{ message: unknown; code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      let message: unknown;
      const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Direct loader deadline exceeded")); }, 2000);
      child.on("message", value => { message = value; });
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("exit", (code, signal) => { clearTimeout(timer); resolve({ message, code, signal }); });
    });
    expect(result).toEqual({ message: { pid: child.pid }, code: 0, signal: null });
  });
  it("retains SQLite only without PostgreSQL markers", async () => {
    expect(selectAddressRadarBackend({})).toBe("sqlite");
    expect(await dispatchPostgresBusinessService("scanner", {})).toBe(false);
    expect(selectAddressRadarBackend({ ADDRESS_RADAR_DATABASE_BACKEND: "sqlite" })).toBe("sqlite");
    expect(() => selectAddressRadarBackend({ ADDRESS_RADAR_DATABASE_BACKEND: "postgres" })).toThrow();
  });
  it.each(["ADDRESS_RADAR_POSTGRES_URL", "ADDRESS_RADAR_POSTGRES_DEPLOYMENT_FILE", "ADDRESS_RADAR_POSTGRES_DEPLOYMENT_SHA256",
    "ADDRESS_RADAR_POSTGRES_ENTRY_SHA256", "ADDRESS_RADAR_POSTGRES_RELEASE_SHA256", "ADDRESS_RADAR_POSTGRES_STARTUP_MS"])("refuses mixed %s without a selector or with SQLite selected", async key => {
    const spawn_ = vi.fn();
    await expect(dispatchPostgresBusinessService("scanner", { [key]: "" }, { spawn: spawn_ })).rejects.toThrow("selector");
    expect(() => selectAddressRadarBackend({ [key]: "present", ADDRESS_RADAR_DATABASE_BACKEND: "sqlite" })).toThrow("selector");
    expect(spawn_).not.toHaveBeenCalled();
  });
  it.each(POSTGRES_BUSINESS_SERVICES)("refuses mutable %s release before spawning, with no SQLite fallback", async service => {
    const { env } = fixture(); const spawn_ = vi.fn();
    await expect(dispatchPostgresBusinessService(service, env, { spawn: spawn_ })).rejects.toThrow();
    expect(spawn_).not.toHaveBeenCalled();
  });
  it.each(["ADDRESS_RADAR_GATEWAY_DELIVERY_ENABLED", "ADDRESS_RADAR_FOMO_BROWSER_ENABLED",
    "ADDRESS_RADAR_FOMO_CAPTURE_ENABLED", "ADDRESS_RADAR_FULL_HISTORICAL_MINING_ENABLED"])("refuses unsafe %s", name => {
    expect(() => assertPostgresServiceSafety({ ...fixture().env, [name]: "true" })).toThrow();
  });
  it.each(["NODE_OPTIONS", "NODE_PATH", "NODE_COMPILE_CACHE", "TSX_TSCONFIG_PATH"])("refuses external loader setting %s", key => {
    expect(() => assertPostgresServiceSafety({ ...fixture().env, [key]: "injected" })).toThrow("loader");
  });
  it("requires protected externally pinned deployment bytes", async () => {
    const { env, path } = fixture(); chmodSync(path, 0o644);
    await expect(readPrivatePostgresDeployment(env)).rejects.toThrow("Unsafe");
    chmodSync(path, 0o600); writeFileSync(path, "{}");
    await expect(readPrivatePostgresDeployment(env)).rejects.toThrow("identity changed");
  });
  it("rejects symlinked execution roots and read-only but service-owned roots", async () => {
    const { root, env, deployment } = fixture();
    const alias = join(root, "alias"); symlinkSync(root, alias);
    await expect(verifyPostgresServiceRelease({ ...deployment, releaseRoot: alias }, env)).rejects.toThrow();
    chmodSync(root, 0o555);
    try { await expect(verifyPostgresServiceRelease(deployment, env)).rejects.toThrow(); }
    finally { chmodSync(root, 0o700); }
  });
  it.skipIf(process.geteuid?.() === 0)("accepts an actual privileged-owner protected executable path without mocking fs", async () => {
    await expect(assertProtectedPostgresPath(realpathSync("/bin/sh"))).resolves.toBeUndefined();
  });
  it.each([undefined, "0", "-1", "Infinity", "01", "60001"])("requires explicit exact lifecycle budget %s", value => {
    expect(() => readPostgresServiceBudgets({ ...fixture().env, ADDRESS_RADAR_POSTGRES_STARTUP_MS: value })).toThrow("bounded");
  });
  it("requires explicit release inventory bounds", async () => {
    const { deployment, env } = fixture();
    await expect(verifyPostgresServiceRelease({ ...deployment, execution: { maximumEntries: 0, maximumBytes: 4096 } }, env)).rejects.toThrow("inventory");
  });
});

describe("bounded PostgreSQL operations", () => {
  it("times out ignored operations without accepting their late completion", async () => {
    const pending = new Set<Promise<unknown>>(); const timedOut = vi.fn();
    let complete!: () => void;
    const result = withPostgresDeadline(() => new Promise<void>(resolve => { complete = resolve; }), {
      maximumMs: 10, pending, onTimeout: timedOut,
    });
    await expect(result).rejects.toThrow("DEADLINE");
    expect(pending.size).toBe(1); expect(timedOut).toHaveBeenCalledTimes(1);
    complete(); await Promise.allSettled([...pending]);
    expect(pending.size).toBe(0);
    await expect(result).rejects.toThrow("DEADLINE");
  });
  it("does not begin an already aborted operation", async () => {
    const controller = new AbortController(); controller.abort(); const operation = vi.fn();
    await expect(withPostgresDeadline(operation, { maximumMs: 10, signal: controller.signal })).rejects.toThrow("ABORTED");
    expect(operation).not.toHaveBeenCalled();
  });
});

describe("bounded child shutdown acknowledgement", () => {
  it("requires ready, requested stop, exact drained receipt and clean exit", async () => {
    const { child, typed, emitter } = childFixture();
    const result = supervisePostgresServiceChild(typed, { identity, budgets, signalEmitter: emitter as never });
    child.emit("message", notice("postgres-service-ready")); emitter.emit("SIGTERM");
    child.emit("message", notice("postgres-service-drained")); child.emit("exit", 0, null);
    await expect(result).resolves.toBeUndefined(); expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(emitter.listenerCount("SIGTERM")).toBe(0);
  });
  it.each(["no-receipt", "wrong-generation", "wrong-release", "wrong-nonce", "signal-exit", "unsolicited"])("refuses %s shutdown", async fault => {
    const { child, typed, emitter } = childFixture();
    const result = supervisePostgresServiceChild(typed, { identity, budgets, signalEmitter: emitter as never });
    const rejected = expect(result).rejects.toThrow("successful shutdown drain");
    child.emit("message", notice("postgres-service-ready"));
    if (fault !== "unsolicited") emitter.emit("SIGTERM");
    if (fault !== "no-receipt") child.emit("message", { ...notice("postgres-service-drained"),
      ...(fault === "wrong-generation" ? { generationId: "other" } : {}),
      ...(fault === "wrong-release" ? { releaseSha256: digest("other") } : {}),
      ...(fault === "wrong-nonce" ? { nonce: "f".repeat(32) } : {}) });
    child.emit("exit", fault === "signal-exit" ? null : 0, fault === "signal-exit" ? "SIGTERM" : null);
    await rejected;
  });
  it("kills an uncooperative real offline child instead of hanging", async () => {
    const child = spawn(process.execPath, ["-e", `process.on('SIGTERM',()=>{}); process.send(${JSON.stringify(notice("postgres-service-ready"))}); setInterval(()=>{},1000);`],
      { stdio: ["ignore", "ignore", "ignore", "ipc"] });
    const emitter = new EventEmitter();
    const result = supervisePostgresServiceChild(child, { identity, budgets: { ...budgets, shutdownMs: 30 }, signalEmitter: emitter as never });
    child.once("message", () => emitter.emit("SIGTERM"));
    await expect(result).rejects.toThrow("drain deadline");
    expect(child.signalCode).toBe("SIGKILL");
  });
  it("accepts a real child only after its clean drain acknowledgement", async () => {
    const child = spawn(process.execPath, ["-e", `process.on('SIGTERM',()=>{process.send(${JSON.stringify(notice("postgres-service-drained"))},()=>process.exit(0));}); process.send(${JSON.stringify(notice("postgres-service-ready"))}); setInterval(()=>{},1000);`],
      { stdio: ["ignore", "ignore", "ignore", "ipc"] });
    const emitter = new EventEmitter();
    const result = supervisePostgresServiceChild(child, { identity, budgets, signalEmitter: emitter as never });
    child.once("message", () => emitter.emit("SIGTERM"));
    await expect(result).resolves.toBeUndefined(); expect(child.exitCode).toBe(0);
  });
  it("rejects late startup and drain receipts after a deadline", async () => {
    const { child, typed, emitter } = childFixture();
    const result = supervisePostgresServiceChild(typed, { identity, budgets: { startupMs: 10, pollMs: 10, shutdownMs: 10, killMs: 10 }, signalEmitter: emitter as never });
    const rejected = expect(result).rejects.toThrow("startup deadline");
    await new Promise(resolve => setTimeout(resolve, 15));
    child.emit("message", notice("postgres-service-ready")); child.emit("message", notice("postgres-service-drained"));
    child.emit("exit", 0, null); await rejected;
  });
});
