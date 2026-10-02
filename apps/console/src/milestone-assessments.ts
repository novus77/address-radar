import type { DatabaseSync } from "node:sqlite";
import { CANDIDATE_MILESTONES } from "@address-radar/scoring";

const labels = {
  milestone_confirmed: "里程碑已确认",
  historical_missing: "历史数据待补齐",
  waiting_confirmation: "实时监控：等待里程碑确认",
  source_unavailable: "当前数据源无法覆盖",
  unverified: "依据不足，暂不能判断",
} as const;
type State = keyof typeof labels;

export function readMilestoneAssessments(database: DatabaseSync, now = Date.now()) {
  const limit = 200;
  const minimumMilestoneUsd = Math.min(...CANDIDATE_MILESTONES.map(item => item.marketCapUsd));
  const inventory = database.prepare(`
    WITH tokens AS (
      SELECT token_id,last_observed_at observed_at FROM token_observation_state
      UNION ALL SELECT token_id,0 observed_at FROM historical_tokens
    ) SELECT token_id tokenId,MAX(observed_at) observedAt FROM tokens
      GROUP BY token_id ORDER BY observedAt DESC,token_id LIMIT ?
  `).all(limit) as Array<{ tokenId: string; observedAt: number }>;
  if (inventory.length === 0) return { updatedAt: now, scope: "latest_observed_tokens", limit, minimumMilestoneUsd, items: [], counts: {}, diagnosticZh: "尚无已知代币；不是历史未达标的结论" };
  const ids = inventory.map(item => item.tokenId);
  const placeholders = ids.map(() => "?").join(",");
  const historical = new Set((database.prepare(`
    SELECT token_id tokenId FROM historical_tokens WHERE token_id IN (${placeholders})
    UNION SELECT subject_key tokenId FROM recovery_jobs WHERE subject_key IN (${placeholders})
      AND job_type IN ('historical_research','market_history','fomo_token_history','milestone_early_buyers')
  `).all(...ids, ...ids) as Array<{ tokenId: string }>).map(item => item.tokenId));
  const crossed = new Map((database.prepare(`SELECT token_id tokenId,MAX(market_cap_usd) marketCapUsd,MAX(crossed_at) crossedAt
    FROM token_milestone_crossings WHERE token_id IN (${placeholders}) AND typeof(crossed_at)='integer'
      AND crossed_at>0 AND crossed_at<=? AND market_cap_usd>=? AND precision NOT IN ('unavailable','fdv_proxy')
      AND length(trim(source))>0 GROUP BY token_id`).all(...ids, now, minimumMilestoneUsd) as Array<{ tokenId: string; marketCapUsd: number; crossedAt: number }>).map(item => [item.tokenId, item]));
  const facts = new Map((database.prepare(`SELECT token_id tokenId,fact_type factType,status,fresh_until freshUntil,terminal_reason terminalReason
    FROM token_fact_status WHERE token_id IN (${placeholders}) AND fact_type IN ('milestone_crossings','market_identity')`)
    .all(...ids) as Array<{ tokenId: string; factType: string; status: string; freshUntil: number | null; terminalReason: string | null }>).map(item => [`${item.tokenId}:${item.factType}`, item]));
  const observations = new Map((database.prepare(`SELECT token_id tokenId,market_status marketStatus,market_cap_usd marketCapUsd,last_observed_at observedAt
    FROM token_observation_state WHERE token_id IN (${placeholders})`).all(...ids) as Array<{ tokenId: string; marketStatus: string; marketCapUsd: number | null; observedAt: number }>).map(item => [item.tokenId, item]));
  const counts: Partial<Record<State, number>> = {};
  const items = inventory.map(token => {
    const milestone = facts.get(`${token.tokenId}:milestone_crossings`);
    const market = facts.get(`${token.tokenId}:market_identity`);
    const observation = observations.get(token.tokenId);
    const crossing = crossed.get(token.tokenId);
    let state: State = "unverified";
    let diagnosticZh = "缺少新鲜且已验证的市场依据；不能判断历史是否达标";
    if (milestone?.status === "conflicted") {
      diagnosticZh = "里程碑依据存在冲突，等待核对；不能据此淘汰";
    } else if (crossing) {
      state = "milestone_confirmed"; diagnosticZh = "已有有效市值里程碑；不等于交易员已经准入或信号已经投递";
    } else if (milestone?.status === "terminal_unavailable") {
      state = "source_unavailable"; diagnosticZh = "当前数据源未能覆盖所需区间；不代表所有来源都无法获取，也不代表历史未达标";
    } else if (historical.has(token.tokenId)) {
      state = "historical_missing"; diagnosticZh = "需要历史回补，但尚无有效里程碑证明；当前市值低或部分价格数据不代表历史未达标";
    } else if (observation && ["resolved", "confirmed"].includes(observation.marketStatus)
      && market?.status === "available" && market.freshUntil !== null && market.freshUntil >= now
      && observation.observedAt > 0 && observation.observedAt <= now
      && typeof observation.marketCapUsd === "number" && Number.isFinite(observation.marketCapUsd)
      && observation.marketCapUsd > 0 && observation.marketCapUsd < minimumMilestoneUsd) {
      state = "waiting_confirmation"; diagnosticZh = "有效期内的最近观测低于首档门槛，继续实时监控；不证明历史从未达标";
    }
    counts[state] = (counts[state] ?? 0) + 1;
    return { tokenId: token.tokenId, chain: token.tokenId.split(":")[0], state, stateLabel: labels[state], diagnosticZh,
      historicalRequired: historical.has(token.tokenId), observedAt: observation?.observedAt ?? null,
      observedMarketCapUsd: observation?.marketCapUsd ?? null, verifiedMilestoneUsd: crossing?.marketCapUsd ?? null,
      verifiedCrossedAt: crossing?.crossedAt ?? null, reasonCode: milestone?.terminalReason ?? null };
  });
  return { updatedAt: now, scope: "latest_observed_tokens", limit, minimumMilestoneUsd, items, counts,
    diagnosticZh: `仅展示最近已知的 ${items.length} 个代币，分类数量不是全库覆盖率；不会推断历史从未达标` };
}
