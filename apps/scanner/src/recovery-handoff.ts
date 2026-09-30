export interface RecoveryHandoff {
  readonly kind: "fomo_milestone_lookup";
  readonly lookupId: string;
  readonly milestoneId: string;
  readonly beforeAt: number;
  readonly submittedAt: number;
  readonly checkAt: number;
  readonly lookupRevision?: number;
}

export function parseRecoveryHandoff(cursor: string | null): RecoveryHandoff | null {
  if (!cursor) return null;
  try {
    const value = JSON.parse(cursor) as Partial<RecoveryHandoff>;
    if (value.kind !== "fomo_milestone_lookup" || typeof value.lookupId !== "string" || !value.lookupId.trim()
      || typeof value.milestoneId !== "string" || !value.milestoneId.trim()) return null;
    if (![value.beforeAt, value.submittedAt, value.checkAt].every(timestamp => typeof timestamp === "number" && Number.isSafeInteger(timestamp) && timestamp >= 0)) return null;
    if (value.checkAt! < value.submittedAt!) return null;
    if (value.lookupRevision !== undefined && (!Number.isSafeInteger(value.lookupRevision) || value.lookupRevision < 0)) return null;
    return value as RecoveryHandoff;
  } catch { return null; }
}

export function recoveryHandoffAction(handoff: RecoveryHandoff, now: number, resultReceived: boolean):
  | { readonly action: "wait"; readonly retryAt: number; readonly reason: string }
  | { readonly action: "resubmit"; readonly lookupRevision: number; readonly retryAt: number } {
  if (resultReceived) return { action: "wait", retryAt: now + 2 * 3_600_000, reason: "waiting_canonical_trade" };
  if (now < handoff.checkAt) return { action: "wait", retryAt: handoff.checkAt, reason: "waiting_result" };
  const revision = handoff.lookupRevision ?? 0;
  if (revision >= 3) return { action: "wait", retryAt: now + 12 * 3_600_000, reason: "lookup_retries_exhausted" };
  const lookupRevision = revision + 1;
  return { action: "resubmit", lookupRevision, retryAt: now + (lookupRevision === 1 ? 2 : 12) * 3_600_000 };
}
