import { randomUUID } from "node:crypto";
import { createPostgresCaptureHealthRepository, type CaptureHealthKind } from "@address-radar/database";
import { createPostgresFomoCdpCapture } from "./postgres-fomo-cdp-capture.js";

// Explicit lifecycle composition only: no active runtime or browser configuration is changed here.
export function createPostgresFomoCaptureLifecycle(input: Parameters<typeof createPostgresFomoCdpCapture>[0]) {
  const now = input.now ?? Date.now;
  const startedAt = now();
  let sessionId = "";
  const wrapped = {
    async run<T>(operation: Parameters<typeof input.unitOfWork.run<T>>[0]): Promise<T> {
      return input.unitOfWork.run(async transaction => {
        const health = createPostgresCaptureHealthRepository(transaction);
        await health.assertActive(sessionId);
        const value = await operation(transaction);
        await health.heartbeat(sessionId,now());
        return value;
      });
    },
  };
  const capture = createPostgresFomoCdpCapture({ ...input, unitOfWork: wrapped });
  sessionId = capture.diagnostics().sessionId;
  let started = false;
  let starting: Promise<void> | null = null;
  let closed = false;
  let shutdownComplete = false;
  let shuttingDown: Promise<void> | null = null;
  let transportConnected = false;
  let flushing: Promise<number> | null = null;
  let pendingHealth: { readonly eventId:string; readonly kind:CaptureHealthKind; readonly occurredAt:number } | null = null;

  function remember(kind: CaptureHealthKind): void {
    pendingHealth ??= { eventId:randomUUID(),kind,occurredAt:now() };
  }
  async function recordPending(): Promise<void> {
    const event = pendingHealth;
    if (event === null) return;
    await input.unitOfWork.run(transaction => createPostgresCaptureHealthRepository(transaction).transition(sessionId,event));
    if (pendingHealth === event) pendingHealth = null;
    if (event.kind === "closed") shutdownComplete = true;
  }
  async function mark(kind: CaptureHealthKind): Promise<void> {
    await recordPending();
    remember(kind);
    await recordPending();
  }
  async function drain(): Promise<number> {
    await recordPending();
    try { return await capture.flush(); } catch (error) {
      remember("persistence");
      try { await recordPending(); } catch { /* The retained event must be retried after storage recovers. */ }
      throw error;
    }
  }
  return Object.freeze({
    async start(): Promise<void> {
      if (closed) throw new Error("FOMO capture lifecycle is closed");
      if (started) return;
      if (starting === null) starting = input.unitOfWork.run(async transaction => {
        await createPostgresCaptureHealthRepository(transaction).start({ sessionId,sourceNamespace:"fomo-live-feed",
          collectorId:input.collectorId,pageId:input.pageId,startedAt });
      }).then(() => { started = true; }).finally(() => { starting = null; });
      return starting;
    },
    async connection(connected: boolean): Promise<void> {
      if (!started || closed) throw new Error("FOMO capture lifecycle is not running");
      transportConnected = connected;
      if (!connected) { capture.pause("disconnected"); await mark("disconnected"); }
      else if (capture.diagnostics().pausedReason === null) await mark("connected");
      else await recordPending();
    },
    receiveCdpMessage(body: string): boolean {
      if (!started || closed) throw new Error("FOMO capture lifecycle is not running");
      if (!transportConnected) capture.pause("disconnected");
      const accepted = capture.receiveCdpMessage(body);
      if (capture.diagnostics().pausedReason === "capacity") remember("capacity");
      return accepted;
    },
    flush(): Promise<number> {
      if (!started) return Promise.reject(new Error("FOMO capture lifecycle has not started"));
      if (flushing === null) flushing = drain().finally(() => { flushing = null; });
      return flushing;
    },
    async resume(): Promise<boolean> {
      if (!started || closed || !transportConnected || flushing !== null || capture.diagnostics().pending > 0) return false;
      await mark("connected");
      return capture.resume();
    },
    async heartbeat(): Promise<void> {
      if (!started || closed) throw new Error("FOMO capture lifecycle is not running");
      await recordPending();
      await input.unitOfWork.run(transaction => createPostgresCaptureHealthRepository(transaction).heartbeat(sessionId,now()));
    },
    close(): Promise<void> {
      if (shutdownComplete) return Promise.resolve();
      if (shuttingDown !== null) return shuttingDown;
      closed = true;
      transportConnected = false;
      capture.pause("disconnected");
      shuttingDown = (async () => {
        if (starting !== null) await starting;
        if (!started) { shutdownComplete = true; return; }
        if (flushing !== null) await flushing;
        await drain();
        if (!shutdownComplete) await mark("closed");
      })().finally(() => { shuttingDown = null; });
      return shuttingDown;
    },
    diagnostics() { return Object.freeze({ ...capture.diagnostics(),started,closed,transportConnected,
      pendingHealthKind:pendingHealth?.kind ?? null }); },
  });
}
