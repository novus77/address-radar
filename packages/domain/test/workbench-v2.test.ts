import { describe, expect, it } from "vitest";

import {
  diagnosticReasonFor,
  isTerminalWalletAnalysisPhase,
  TRADER_ABILITY_DEFINITIONS,
  TRADER_SOURCE_DEFINITIONS,
  WORKBENCH_LIFECYCLES,
} from "@address-radar/domain";

describe("workbench v2 domain contracts", () => {
  it("keeps trader source, ability, and lifecycle as separate dimensions", () => {
    expect(TRADER_SOURCE_DEFINITIONS.leaderboard_30d_top100.labelZh).toBe("30天TOP100");
    expect(TRADER_SOURCE_DEFINITIONS.manual.labelZh).toBe("手动添加");
    expect(TRADER_ABILITY_DEFINITIONS.early_multiplier.labelZh).toBe("早期高倍");
    expect(WORKBENCH_LIFECYCLES).toContain("fomo_only");
    expect(WORKBENCH_LIFECYCLES).toContain("observing");
  });

  it("turns incomplete sample facts into an actionable Chinese diagnostic", () => {
    expect(diagnosticReasonFor({
      hasTokenIdentity: true,
      hasEntryPrice: false,
      hasCurrentPrice: false,
      hasPeakPrice: false,
      hasTradeDirection: true,
      providerAvailable: true,
      reevaluationPending: false,
      sampleValid: true,
    })).toMatchObject({
      code: "missing_entry_price",
      labelZh: "缺少入场价格",
      retryable: true,
    });
  });

  it("distinguishes terminal wallet analysis phases from recoverable phases", () => {
    expect(isTerminalWalletAnalysisPhase("completed")).toBe(true);
    expect(isTerminalWalletAnalysisPhase("cancelled")).toBe(true);
    expect(isTerminalWalletAnalysisPhase("blocked")).toBe(false);
    expect(isTerminalWalletAnalysisPhase("retrying")).toBe(false);
  });
});
