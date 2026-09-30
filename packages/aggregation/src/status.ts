const formatUsd = (value: number): string => `$${Math.max(0, value).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

const numericSuffix = (condition: string): number | null => {
  const separator = condition.indexOf(":");
  if (separator < 0) return null;
  const value = Number(condition.slice(separator + 1));
  return Number.isFinite(value) ? value : null;
};

export function explainTokenMissingCondition(condition: string): string {
  if (condition === "fresh_evidence") return "等待新的买入证据";
  if (condition === "token_lifecycle") return "等待确认代币阶段";
  if (condition === "early_or_high_multiple_trader") return "等待早期高倍交易员参与";
  const value = numericSuffix(condition);
  if (condition.startsWith("distinct_traders:") && value !== null) return `还需要 ${value} 名高质量交易员`;
  if (condition.startsWith("repeatable_traders:") && value !== null) return `还需要 ${value} 名稳定复现交易员`;
  if (condition.startsWith("minimum_total_buy_usd:") && value !== null) return `累计买入金额需达到 ${formatUsd(value)}`;
  if (condition.startsWith("single_buy_usd:") && value !== null) return `单笔买入金额需达到 ${formatUsd(value)}`;
  if (condition.startsWith("aggregate_buy_usd:") && value !== null) return `累计买入金额需达到 ${formatUsd(value)}`;
  if (condition.startsWith("large_buy_traders:") && value !== null) return `还需要 ${value} 名大额买入交易员`;
  if (condition.startsWith("score:") && value !== null) return `综合评分需达到 ${Math.round(value * 100)}%`;
  return "等待补充评估数据";
}
