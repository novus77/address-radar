import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { canonicalForwardTargetChannelFact } from '@address-radar/domain';
import type { PostgresTransaction } from '@address-radar/database';
import type { PostgresWalletChannelOptions, PostgresWalletProfile } from '../../wallet-monitor/src/postgres-wallet-channel.js';

export interface PostgresSafetyEvidence {
  readonly protocol: 'address-only-safety-evidence-v1';
  readonly kind: 'risk' | 'independence';
  readonly generationId: string; readonly sampleId: string; readonly executionFingerprint: string;
  readonly revision: { readonly state: 'original'; readonly executionFingerprint: string };
  readonly target: PostgresWalletProfile['fact']; readonly targetVersionId: string;
  readonly chain: 'solana' | 'eth' | 'bsc' | 'base'; readonly tokenAddress: string; readonly boughtAt: number;
  readonly provenance: { readonly providerId: string; readonly sourceRef: string; readonly contentSha256: string;
    readonly observedAt: number; readonly knownAt: number };
  readonly coverage: { readonly status: 'unknown' | 'partial' | 'complete'; readonly scope: string;
    readonly from: number; readonly until: number };
  readonly conflict: 'unknown' | 'none' | 'present';
  /** Evidence references/data only; absence of relations never establishes independence. */
  readonly observations: Readonly<Record<string, unknown>>;
}
export type PostgresSafetyAssessment = {
  readonly status: 'pending'; readonly reasonCode: string; readonly bindingVerified: boolean; readonly publicationAuthorized: false;
} | {
  readonly status: 'blocked'; readonly reasonCode: 'upstream_explicit_block'; readonly bindingVerified: true;
  readonly evidenceFingerprint: string; readonly blockingEvidenceRef: string; readonly publicationAuthorized: false;
};
export interface PostgresSafetyEvidenceOptions {
  readonly generationId: string;
  /** Trusted native read port; this factory never allocates a pool, changes ACLs or owns commits. */
  readonly run: <T>(operation: (transaction: PostgresTransaction) => Promise<T>) => Promise<T>;
  readonly profiles: PostgresWalletChannelOptions['profiles'];
  readonly reviewedProviderIds: readonly string[];
  readonly maximumPayloadBytes: number; readonly maximumProfiles: number;
  readonly maximumEvidenceAgeMs: number; readonly maximumRunMs: number; readonly now: () => number;
  /** Sealed-code port, not a configurable boolean or a business-safe decision. No default implementation. */
  readonly independentlyInspect?: (input: { readonly evidence: PostgresSafetyEvidence; readonly fingerprint: string;
    readonly signal: AbortSignal }) => Promise<{ readonly status: 'pending' } | {
      readonly status: 'verified'; readonly evidenceFingerprint: string;
      readonly disposition: 'unknown' | 'blocked'; readonly evidenceRef?: string;
    }>;
}
class EvidenceRefused extends Error {}
function demand(value: unknown, code: string): asserts value { if (!value) throw new EvidenceRefused(code); }
const id = (v: unknown): v is string => typeof v === 'string' && !!v.trim() && v.length <= 512
  && !/[\x00-\x1f\x7f]/.test(v) && !v.includes('://');
const time = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([k, v]) => JSON.stringify(k) + ':' + canonical(v)).join(',') + '}';
  demand(value !== undefined && (typeof value !== 'number' || Number.isFinite(value)), 'safety_payload_invalid');
  return JSON.stringify(value);
}
export function safetyEvidenceFingerprint(evidence: PostgresSafetyEvidence): string {
  return createHash('sha256').update(canonical(evidence)).digest('hex');
}
const pending = (reasonCode: string, bindingVerified = false): PostgresSafetyAssessment =>
  ({ status: 'pending', reasonCode, bindingVerified, publicationAuthorized: false });

/** Foundational checks only. No positive risk rule, independence grouping, signature or publication is implemented. */
export function createPostgresSafetyEvidenceValidator(inputOptions: PostgresSafetyEvidenceOptions) {
  const options = { ...inputOptions, reviewedProviderIds: [...inputOptions.reviewedProviderIds] };
  demand(id(options.generationId) && typeof options.run === 'function' && typeof options.profiles.load === 'function'
    && typeof options.now === 'function', 'safety_configuration_invalid');
  for (const [v, maximum] of [[options.maximumPayloadBytes, 10_000_000], [options.maximumProfiles, 10_000],
    [options.maximumEvidenceAgeMs, 2147483647], [options.maximumRunMs, 60000]]) {
    demand(time(v) && v > 0 && v <= maximum!, 'safety_explicit_budget_required');
  }
  demand(options.reviewedProviderIds.length > 0 && options.reviewedProviderIds.length <= 64
    && options.reviewedProviderIds.every(id) && new Set(options.reviewedProviderIds).size === options.reviewedProviderIds.length,
    'safety_reviewed_sources_required');
  let busy = false;
  return Object.freeze({ async validateEvidence(input: { readonly evidence: PostgresSafetyEvidence; readonly signal: AbortSignal }): Promise<PostgresSafetyAssessment> {
    if (busy) return pending('safety_verifier_busy');
    if (input.signal.aborted) return pending('safety_verifier_aborted');
    busy = true;
    const controller = new AbortController(), abort = () => controller.abort();
    input.signal.addEventListener('abort', abort, { once: true }); if (input.signal.aborted) abort();
    let lastAt = -1;
    const check = () => {
      controller.signal.throwIfAborted(); const at = options.now();
      demand(time(at) && at >= lastAt, 'safety_clock_invalid'); lastAt = at; return at;
    };
    const stopped = new Promise<PostgresSafetyAssessment>(resolve => {
      controller.signal.addEventListener('abort', () => resolve(pending('safety_verifier_aborted_or_timed_out')), { once: true });
      if (controller.signal.aborted) resolve(pending('safety_verifier_aborted_or_timed_out'));
    });
    const timer = setTimeout(abort, options.maximumRunMs);
    const work = async (): Promise<PostgresSafetyAssessment> => {
      demand(Buffer.byteLength(JSON.stringify(input.evidence)) <= options.maximumPayloadBytes, 'safety_payload_budget');
      const e = structuredClone(input.evidence), at = check();
      demand(e.protocol === 'address-only-safety-evidence-v1' && ['risk', 'independence'].includes(e.kind)
        && e.generationId === options.generationId && id(e.sampleId) && hash(e.executionFingerprint)
        && e.revision.state === 'original' && e.revision.executionFingerprint === e.executionFingerprint
        && ['solana','eth','bsc','base'].includes(e.chain) && id(e.tokenAddress) && time(e.boughtAt) && e.boughtAt <= at,
      'safety_exact_revision_required');
      demand(e.target.channel === 'wallet' && id(e.target.entityId) && id(e.targetVersionId)
        && id(e.target.subjectId) && id(e.target.ownershipEvidenceRef)
        && e.target.walletFamily === (e.chain === 'solana' ? 'solana' : 'evm'), 'safety_exact_target_required');
      demand(isDeepStrictEqual(canonicalForwardTargetChannelFact(e.target), e.target), 'safety_canonical_target_required');
      const p = e.provenance, c = e.coverage;
      demand(id(p.providerId) && options.reviewedProviderIds.includes(p.providerId) && id(p.sourceRef) && hash(p.contentSha256)
        && time(p.observedAt) && time(p.knownAt) && p.observedAt <= p.knownAt && p.knownAt <= at
        && at - p.observedAt <= options.maximumEvidenceAgeMs, 'safety_provenance_or_time_unavailable');
      demand(c.status === 'complete' && id(c.scope) && time(c.from) && time(c.until) && c.from <= e.boughtAt
        && c.until >= e.boughtAt && c.until <= p.observedAt && e.conflict === 'none', 'safety_coverage_or_conflict_unresolved');
      const binding = async () => {
        check();
        const loaded = await options.profiles.load({ generationId: e.generationId, chainFamily: e.target.walletFamily!,
          asOf: check(), limit: options.maximumProfiles, signal: controller.signal }); check();
        demand(loaded.status === 'ready' && loaded.profiles.length <= options.maximumProfiles
          && loaded.profiles.filter(profile => profile.versionId === e.targetVersionId && profile.profileEnabled
            && !profile.profileSuspended && profile.bindingState === 'owned' && profile.wallet.entityId === e.target.entityId
            && isDeepStrictEqual(profile.fact, e.target)).length === 1, 'safety_current_target_unavailable');
        const rows = await options.run(tx => tx.query(`SELECT /* safety-evidence-exact-revision */ s.sample_id,s.entity_id,s.chain,s.token_address,
          s.occurred_at,s.execution_fingerprint,t.original_fingerprint,r.state AS revision_state,r.ownership_evidence_ref
          FROM forward_purchase_samples s JOIN forward_trade_revisions r ON r.trade_id=s.trade_id AND r.fingerprint=s.execution_fingerprint
          JOIN forward_economic_trades t ON t.trade_id=s.trade_id
          WHERE s.generation_id=$1 AND s.sample_id=$2 AND s.execution_fingerprint=$3 AND r.state='original'
            AND t.original_fingerprint=s.execution_fingerprint AND s.entity_id=r.entity_id
            AND s.token_address=r.token_address AND s.occurred_at=r.occurred_at
            AND t.entity_id=s.entity_id AND t.chain=s.chain AND t.token_address=s.token_address AND t.occurred_at=s.occurred_at
            AND s.created_at<=$4 AND r.recorded_at<=$4
            AND NOT EXISTS(SELECT 1 FROM forward_trade_revisions x WHERE x.trade_id=s.trade_id AND x.state='pending_review' AND x.recorded_at<=$4)`,
        [e.generationId,e.sampleId,e.executionFingerprint,check()])); check();
        const row = rows.rows[0];
        demand(rows.rows.length === 1 && row && row.sample_id === e.sampleId && row.entity_id === e.target.entityId
          && row.chain === e.chain && row.token_address === e.tokenAddress && Number(row.occurred_at) === e.boughtAt
          && row.execution_fingerprint === e.executionFingerprint && row.original_fingerprint === e.executionFingerprint
          && row.revision_state === 'original' && row.ownership_evidence_ref === e.target.ownershipEvidenceRef,
        'safety_exact_revision_unavailable');
      };
      await binding();
      if (!options.independentlyInspect) return pending('safety_independent_inspector_unavailable', true);
      const fingerprint = safetyEvidenceFingerprint(e);
      const verdict = await options.independentlyInspect({ evidence: structuredClone(e), fingerprint, signal: controller.signal }); check();
      if (verdict.status !== 'verified' || verdict.evidenceFingerprint !== fingerprint) return pending('safety_evidence_not_independently_verified');
      await binding();
      demand(check() - p.observedAt <= options.maximumEvidenceAgeMs, 'safety_evidence_expired');
      if (verdict.disposition === 'blocked' && id(verdict.evidenceRef)) return { status: 'blocked', reasonCode: 'upstream_explicit_block',
        bindingVerified: true, evidenceFingerprint: fingerprint, blockingEvidenceRef: verdict.evidenceRef, publicationAuthorized: false };
      return pending('safety_decision_policy_unconfirmed', true);
    };
    // An ignored read remains busy until it settles; no overlapping verification or publication can follow a timeout.
    const operation = work().catch(error => pending(error instanceof EvidenceRefused ? error.message : 'safety_evidence_unavailable'))
      .finally(() => { busy = false; });
    try { return await Promise.race([operation, stopped]); }
    finally { clearTimeout(timer); controller.abort(); input.signal.removeEventListener('abort', abort); }
  } });
}

/** Fail-closed placeholder, not a native publisher: no run/pool/key/INSERT port exists until authority and policy are approved. */
export function createPostgresSafetyEvidencePublisher() {
  return Object.freeze({ async publish(input: { readonly assessment: PostgresSafetyAssessment; readonly signal: AbortSignal }) {
    input.signal.throwIfAborted();
    return { status: 'deferred' as const, reasonCode: 'safety_publication_not_authorized' as const };
  } });
}
