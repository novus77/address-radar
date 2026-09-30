export const TRADER_SOURCE_DEFINITIONS = Object.freeze({
  leaderboard_30d_top100: Object.freeze({ labelZh: "30天TOP100" }),
  manual: Object.freeze({ labelZh: "手动添加" }),
  milestone_reverse_discovery: Object.freeze({ labelZh: "里程碑反查" }),
  shared_holding_discovery: Object.freeze({ labelZh: "共同持仓发现" }),
  runtime_discovery: Object.freeze({ labelZh: "运行时发现" }),
});

export type TraderSource = keyof typeof TRADER_SOURCE_DEFINITIONS;

export const TRADER_ABILITY_DEFINITIONS = Object.freeze({
  early_multiplier: Object.freeze({ labelZh: "早期高倍" }),
  large_trend: Object.freeze({ labelZh: "大额趋势" }),
  new_token_hunter: Object.freeze({ labelZh: "新币猎手" }),
  revival_trader: Object.freeze({ labelZh: "老币异动" }),
  high_win_rate: Object.freeze({ labelZh: "高胜率" }),
  high_payoff_ratio: Object.freeze({ labelZh: "高盈亏比" }),
  repeatable_edge: Object.freeze({ labelZh: "稳定复现" }),
  insufficient_samples: Object.freeze({ labelZh: "样本不足" }),
});

export type TraderAbility = keyof typeof TRADER_ABILITY_DEFINITIONS;

export const WORKBENCH_LIFECYCLES = Object.freeze([
  "unresolved",
  "candidate",
  "observing",
  "active",
  "paused",
  "eliminated",
  "fomo_only",
] as const);

export type WorkbenchLifecycle = typeof WORKBENCH_LIFECYCLES[number];

export const WALLET_ANALYSIS_PHASES = Object.freeze([
  "queued",
  "collecting",
  "normalizing",
  "pricing",
  "evaluating",
  "completed",
  "retrying",
  "partial",
  "failed",
  "cancelled",
  "blocked",
] as const);

export type WalletAnalysisPhase = typeof WALLET_ANALYSIS_PHASES[number];

export interface DiagnosticFacts {
  readonly hasTokenIdentity: boolean;
  readonly hasEntryPrice: boolean;
  readonly hasCurrentPrice: boolean;
  readonly hasPeakPrice: boolean;
  readonly hasTradeDirection: boolean;
  readonly providerAvailable: boolean;
  readonly reevaluationPending: boolean;
  readonly sampleValid: boolean;
}

export interface DiagnosticReason {
  readonly code: string;
  readonly labelZh: string;
  readonly detailZh: string;
  readonly retryable: boolean;
}

const reason = (code: string, labelZh: string, detailZh: string, retryable: boolean): DiagnosticReason =>
  Object.freeze({ code, labelZh, detailZh, retryable });

export function diagnosticReasonFor(facts: DiagnosticFacts): DiagnosticReason | null {
  if (!facts.sampleValid) return reason("invalid_sample", "样本无效", "交易数据不满足分析要求", false);
  if (!facts.hasTokenIdentity) return reason("unresolved_token_identity", "代币身份未解析", "链或合约地址尚未完成映射", true);
  if (!facts.hasTradeDirection) return reason("unknown_trade_direction", "交易方向未知", "尚无法判断该事件是买入、卖出或转账", true);
  if (!facts.providerAvailable) return reason("provider_unavailable", "数据源暂不可用", "数据源失败或限流，系统将自动重试", true);
  if (facts.reevaluationPending) return reason("awaiting_reevaluation", "等待重新评估", "所需数据已更新，等待下一轮评估", true);
  if (!facts.hasEntryPrice) return reason("missing_entry_price", "缺少入场价格", "无法计算该交易员的入场成本", true);
  if (!facts.hasCurrentPrice) return reason("missing_current_price", "缺少当前价格", "无法计算当前收益", true);
  if (!facts.hasPeakPrice) return reason("missing_peak_price", "缺少历史最高价", "可以计算当前收益，但无法计算最高倍数", true);
  return null;
}

export function isTerminalWalletAnalysisPhase(phase: WalletAnalysisPhase): boolean {
  return phase === "completed" || phase === "partial" || phase === "failed" || phase === "cancelled";
}
