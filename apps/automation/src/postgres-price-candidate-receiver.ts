import type { PostgresPriceCandidate, PostgresPricePoolMapping } from "./postgres-controlled-price-producer.js";
import type { PostgresPricePublication, SignedPostgresPriceValidation } from "./postgres-price-fact-publisher.js";

export interface PostgresPriceCandidateRequest {
  readonly generationId: string; readonly sampleId: string; readonly executionFingerprint: string;
  readonly boughtAt: number; readonly until: number; readonly mapping?: PostgresPricePoolMapping;
}
export interface PostgresPriceCandidateReceiverOptions {
  readonly generationId: string;
  readonly producer: { acquire(input: { readonly generationId: string; readonly sampleId: string; readonly executionFingerprint: string;
    readonly boughtAt: number; readonly until: number; readonly mapping: PostgresPricePoolMapping; readonly signal: AbortSignal }): Promise<
      { readonly status: 'acquired'; readonly candidate: PostgresPriceCandidate } | { readonly status: 'deferred'; readonly reasonCode: string }> };
  readonly validator?: { validatePrice(input: { readonly candidate: PostgresPriceCandidate; readonly signal: AbortSignal }): Promise<
    { readonly status: "verified"; readonly validation: SignedPostgresPriceValidation }
    | { readonly status: "deferred"; readonly reasonCode: string }> };
  readonly publisher?: { publish(input: { readonly candidate: PostgresPriceCandidate;
    readonly validation: SignedPostgresPriceValidation; readonly signal: AbortSignal }): Promise<PostgresPricePublication> };
  readonly maximumCandidates: number; readonly maximumRunMs: number; readonly maximumPayloadBytes: number;
  readonly now: () => number;
}
export function createPostgresPriceCandidateReceiver(options: PostgresPriceCandidateReceiverOptions) {
  if (!options.generationId.trim() || options.generationId.length > 512 || typeof options.producer.acquire !== "function"
    || !Number.isSafeInteger(options.maximumCandidates) || options.maximumCandidates < 1 || options.maximumCandidates > 1000
    || !Number.isSafeInteger(options.maximumRunMs) || options.maximumRunMs < 1 || options.maximumRunMs > 2_147_483_647
    || !Number.isSafeInteger(options.maximumPayloadBytes) || options.maximumPayloadBytes < 1 || options.maximumPayloadBytes > 10_000_000) {
    throw new Error("Explicit bounded price receiver ports required");
  }
  let busy = false;
  return Object.freeze({
    async receive(input: { readonly requests: readonly PostgresPriceCandidateRequest[]; readonly signal: AbortSignal }) {
      if (busy) throw new Error("Price receiver busy");
      input.signal.throwIfAborted();
      if (input.requests.length > options.maximumCandidates || Buffer.byteLength(JSON.stringify(input.requests)) > options.maximumPayloadBytes) {
        throw new Error("Price receiver batch exceeds budget");
      }
      const requests = structuredClone(input.requests), started = options.now();
      if (!Number.isSafeInteger(started) || started < 0) throw new Error("Invalid receiver clock");
      busy = true;
      const controller = new AbortController(), abort = () => controller.abort();
      input.signal.addEventListener("abort", abort, { once: true }); if (input.signal.aborted) abort();
      const timer = setTimeout(abort, options.maximumRunMs);
      let onAbort: () => void = () => {};
      const stopped = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(new Error("price_receiver_deadline"));
        controller.signal.addEventListener("abort", onAbort, { once: true });
        if (controller.signal.aborted) onAbort();
      });
      // Handled even when a batch is entirely deferred before the first asynchronous call.
      void stopped.catch(() => undefined);
      const bounded = async <T>(operation: () => Promise<T>): Promise<T> => {
        controller.signal.throwIfAborted(); const at = options.now();
        if (!Number.isSafeInteger(at) || at < started || at - started >= options.maximumRunMs) throw new Error("price_receiver_clock_or_deadline");
        return Promise.race([operation(), stopped]);
      };
      const results: { readonly sampleId: string; readonly status: "published" | "duplicate" | "deferred";
        readonly reasonCode?: string; readonly factIds?: readonly string[] }[] = [];
      try {
        for (const request of requests) {
          const defer = (reasonCode: string) => results.push({ sampleId: request.sampleId, status: "deferred", reasonCode });
          if (request.generationId !== options.generationId || !request.mapping) { defer("approved_price_mapping_or_generation_unavailable"); continue; }
          try {
            const proof = await bounded(() => options.producer.acquire({ ...request, mapping: request.mapping!, signal: controller.signal }));
            if (proof.status !== "acquired") { defer(proof.reasonCode); continue; }
            const candidate = structuredClone(proof.candidate);
            if (candidate.generationId !== request.generationId || candidate.sampleId !== request.sampleId
              || candidate.executionFingerprint !== request.executionFingerprint || candidate.boughtAt !== request.boughtAt
              || candidate.until !== request.until || JSON.stringify(candidate.mapping) !== JSON.stringify(request.mapping)) {
              defer("price_candidate_request_mismatch"); continue;
            }
            if (Buffer.byteLength(JSON.stringify(candidate)) > options.maximumPayloadBytes) { defer("price_candidate_payload_budget"); continue; }
            if (!options.validator || !options.publisher) { defer("independent_price_validator_or_publisher_unavailable"); continue; }
            const verdict = await bounded(() => options.validator!.validatePrice({ candidate, signal: controller.signal }));
            if (verdict.status !== "verified") { defer(verdict.reasonCode); continue; }
            if (Buffer.byteLength(JSON.stringify(verdict)) + Buffer.byteLength(JSON.stringify(candidate)) > options.maximumPayloadBytes) {
              defer("price_validation_payload_budget"); continue;
            }
            const publication = await bounded(() => options.publisher!.publish({ candidate, validation: verdict.validation, signal: controller.signal }));
            if (publication.status === "deferred") { defer(publication.reasonCode); continue; }
            results.push({ sampleId: request.sampleId, status: publication.status, factIds: publication.factIds });
          } catch { defer(controller.signal.aborted ? "price_receiver_aborted" : "price_source_or_publication_unavailable"); }
        }
        return { published: results.filter(result => result.status === "published").length,
          duplicates: results.filter(result => result.status === "duplicate").length, results };
      } finally {
        controller.abort(); clearTimeout(timer); input.signal.removeEventListener("abort", abort);
        controller.signal.removeEventListener("abort", onAbort); busy = false;
      }
    },
  });
}
