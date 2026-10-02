import { normalizeFomoLiveActivity, type FomoLiveActivity } from "./live-activity.js";

export interface FomoActivityTarget {
  readonly accountId: string;
  readonly entityId: string;
}

export function selectFomoTargetActivity(
  body: string,
  targets: readonly FomoActivityTarget[],
): { readonly entityId: string; readonly activity: FomoLiveActivity } | null {
  const activity = normalizeFomoLiveActivity(body);
  if (!activity) return null;
  const owners = new Set(targets.filter(target => target.accountId === activity.accountId).map(target => target.entityId));
  if (owners.size !== 1) return null;
  const entityId = [...owners][0];
  if (!entityId?.trim()) return null;
  return Object.freeze({ entityId, activity });
}
