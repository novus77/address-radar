import { describe, expect, it } from "vitest";

import { explainTokenMissingCondition } from "@address-radar/aggregation";

describe("workbench v2 aggregation status", () => {
  it.each([
    ["fresh_evidence", "等待新的买入证据"],
    ["token_lifecycle", "等待确认代币阶段"],
    ["distinct_traders:3", "还需要 3 名高质量交易员"],
    ["early_or_high_multiple_trader", "等待早期高倍交易员参与"],
    ["repeatable_traders:2", "还需要 2 名稳定复现交易员"],
    ["minimum_total_buy_usd:100", "累计买入金额需达到 $100"],
    ["single_buy_usd:10000", "单笔买入金额需达到 $10,000"],
    ["aggregate_buy_usd:20000", "累计买入金额需达到 $20,000"],
    ["large_buy_traders:2", "还需要 2 名大额买入交易员"],
    ["score:0.7", "综合评分需达到 70%"],
  ])("explains %s in Chinese", (condition, expected) => {
    expect(explainTokenMissingCondition(condition)).toBe(expected);
  });

  it("uses a safe Chinese fallback instead of exposing an unknown database code", () => {
    expect(explainTokenMissingCondition("provider:new-code")).toBe("等待补充评估数据");
  });
});
