import { preparePostgresWalletCapture, type CapturedPostgresWalletEvent, type CapturedWalletPurchaseResolution,
  type PostgresWalletChannelOptions } from "../../wallet-monitor/src/postgres-wallet-channel.js";
import type { PostgresSolanaExecutionAcquisition } from "./postgres-wallet-rpc-producer.js";
import type { PostgresEvmExecutionAcquisition } from "./postgres-evm-execution-producer.js";
import type { PostgresExecutionCandidate, PostgresExecutionPublication, SignedPostgresExecutionValidation } from "./postgres-execution-fact-publisher.js";

export interface PostgresWalletExecutionReceiverOptions {
  readonly generationId: string;
  readonly producer: { acquire(input: { readonly payload: CapturedPostgresWalletEvent; readonly signal: AbortSignal }): Promise<PostgresSolanaExecutionAcquisition> };
  /** Optional explicit EVM registry dispatcher. Never send an EVM capture to the Solana producer. */
  readonly evmProducer?: { acquire(input: { readonly payload: CapturedPostgresWalletEvent; readonly signal: AbortSignal }): Promise<PostgresEvmExecutionAcquisition> };
  /** External independent validation transport. Absence or unsigned/unbound verdict never becomes a success. */
  readonly validator?: { validateExecution(input: { readonly candidate: PostgresExecutionCandidate; readonly signal: AbortSignal }): Promise<
    { readonly status: "verified"; readonly validation: SignedPostgresExecutionValidation } | { readonly status: "deferred"; readonly reasonCode: string }> };
  readonly publisher?: { publish(input: { readonly candidate: PostgresExecutionCandidate;
    readonly validation: SignedPostgresExecutionValidation; readonly signal: AbortSignal }): Promise<PostgresExecutionPublication> };
  readonly maximumCandidates: number; readonly maximumRunMs: number; readonly maximumPayloadBytes: number; readonly now: () => number;
}
export function createPostgresWalletExecutionReceiver(options: PostgresWalletExecutionReceiverOptions) {
  if (!options.generationId.trim()) throw new Error("Explicit receiver generation required");
  for (const [value, max] of [[options.maximumCandidates, 1000], [options.maximumRunMs, 2_147_483_647], [options.maximumPayloadBytes, 10_000_000]]) {
    if (!Number.isSafeInteger(value) || value! < 1 || value! > max!) throw new Error("Explicit bounded receiver budget required");
  }
  let busy = false;
  const deferred = (reasonCode: string): CapturedWalletPurchaseResolution => ({ status: "deferred", reasonCode });
  async function receive(input: { readonly payloads: readonly CapturedPostgresWalletEvent[]; readonly signal: AbortSignal }) {
    if (input.payloads.length > options.maximumCandidates || Buffer.byteLength(JSON.stringify(input.payloads)) > options.maximumPayloadBytes) {
      throw new Error("Receiver batch exceeds explicit budget");
    }
    if (busy) throw new Error("Receiver already processing a bounded batch");
    busy = true;
    const controller = new AbortController(), abort = () => controller.abort();
    input.signal.addEventListener("abort", abort, { once: true }); if (input.signal.aborted) abort();
    const timer = setTimeout(abort, options.maximumRunMs);
    const results: CapturedWalletPurchaseResolution[] = [];
    let acquired = 0, published = 0;
    async function bounded<T>(operation: () => Promise<T>): Promise<T> {
      controller.signal.throwIfAborted();
      let onAbort: () => void = () => {};
      const stopped = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(new Error("receiver_deadline")); controller.signal.addEventListener("abort", onAbort, { once: true });
      });
      try { return await Promise.race([operation(), stopped]); }
      finally { controller.signal.removeEventListener("abort", onAbort); }
    }
    try {
      for (const original of input.payloads) {
        if (controller.signal.aborted) { results.push(deferred("receiver_aborted_or_timed_out")); continue; }
        const payload = structuredClone(original);
        if (payload.generationId !== options.generationId || payload.event.side !== "buy") {
          results.push(deferred("unsupported_or_wrong_generation_capture")); continue;
        }
        try {
          const producer = payload.chainFamily === "solana" ? options.producer : payload.chainFamily === "evm" ? options.evmProducer : undefined;
          if (!producer) { results.push(deferred("execution_producer_unavailable_for_chain")); continue; }
          const proof = await bounded<PostgresSolanaExecutionAcquisition | PostgresEvmExecutionAcquisition>(
            () => producer.acquire({ payload, signal: controller.signal }));
          if (proof.status === "deferred") { results.push(deferred(proof.reasonCode)); continue; }
          acquired++;
          if (!options.validator || !options.publisher) { results.push(deferred("independent_validator_or_publisher_unavailable")); continue; }
          const validation = await bounded(() => options.validator!.validateExecution({ candidate: structuredClone(proof.candidate), signal: controller.signal }));
          if (validation.status !== "verified") { results.push(deferred(validation.reasonCode)); continue; }
          controller.signal.throwIfAborted();
          // Do not race publication/commit: the dedicated native UOW owns explicit DB timeouts and atomic acknowledgement.
          const stored = await options.publisher.publish({ candidate: proof.candidate, validation: validation.validation, signal: controller.signal });
          published++; results.push({ status: "verified", purchase: stored.purchase, externalBasis: stored.externalBasis });
        } catch { results.push(deferred("execution_validation_or_publication_unavailable")); }
      }
      return { processed: results.length, acquired, published, deferred: results.length - published, results };
    } finally { controller.abort(); clearTimeout(timer); input.signal.removeEventListener("abort", abort); busy = false; }
  }
  const verifyPurchase: NonNullable<PostgresWalletChannelOptions["verifyPurchase"]> = async input => {
    if (input.generationId !== options.generationId || input.event.side !== "buy") {
      return deferred("unsupported_or_wrong_generation_capture");
    }
    const payload = preparePostgresWalletCapture({ generationId: input.generationId, collectorId: input.collector.name,
      sessionId: input.collector.name, chainFamily: input.collector.chainFamily, receivedAt: options.now(),
      profile: input.profile, event: input.event, executionTrust: "unverified" }).payload;
    return (await receive({ payloads: [payload], signal: input.signal })).results[0]!;
  };
  return Object.freeze({ receive, verifyPurchase });
}
