import type { createPostgresRpcSourceFactCandidateVerifier, PostgresRpcSourceFactCandidateRequest } from "./postgres-rpc-source-fact-candidate.js";
import type { createPostgresIndependentSourceValidator } from "./postgres-independent-source-validator.js";
import type { createPostgresSourceFactPublisher, PostgresSourcePublishResult } from "./postgres-source-fact-publisher.js";
export interface PostgresSourceFactReceiverOptions {
  readonly candidateVerifier: ReturnType<typeof createPostgresRpcSourceFactCandidateVerifier>;
  readonly validator?: ReturnType<typeof createPostgresIndependentSourceValidator>;
  readonly publisher?: Awaited<ReturnType<typeof createPostgresSourceFactPublisher>>;
  readonly maximumPayloadBytes: number;
}
export function createPostgresSourceFactReceiver(options: PostgresSourceFactReceiverOptions) {
  if (!Number.isSafeInteger(options.maximumPayloadBytes) || options.maximumPayloadBytes <= 0) throw new Error("Explicit source receiver budget required");
  return Object.freeze({ async receive(request: PostgresRpcSourceFactCandidateRequest): Promise<PostgresSourcePublishResult> {
    if (!options.validator || !options.publisher) return { status: "deferred", reasonCode: "source_validator_or_publisher_unavailable" };
    if (request.signal.aborted) return { status: "deferred", reasonCode: "source_receiver_aborted" };
    if (Buffer.byteLength(JSON.stringify(request)) > options.maximumPayloadBytes) return { status: "deferred", reasonCode: "source_payload_budget" };
    const candidate = await options.candidateVerifier.verify(request);
    if (candidate.status !== "candidate_ready") return candidate;
    const result = await options.validator.validateSource({ candidate: candidate.candidate, signal: request.signal });
    if (result.status !== "verified") return result;
    return options.publisher.publish({ candidate: candidate.candidate, validation: result.validation, signal: request.signal });
  } });
}
