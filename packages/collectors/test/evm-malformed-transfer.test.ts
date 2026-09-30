import { describe, expect, it } from "vitest";
import { extractEvmSwapEvidence } from "../src/evm-swap-evidence.js";

describe("malformed transfer isolation", () => {
  it("ignores empty and ERC721 data without discarding valid transfers", () => {
    const wallet = "0x1111111111111111111111111111111111111111";
    const topic = `0x${wallet.slice(2).padStart(64, "0")}`;
    const base = { address: "0x2222222222222222222222222222222222222222", topics: ["0xddf252ad", "0x" + "0".repeat(64), topic] };
    const result = extractEvmSwapEvidence({ wallet, transaction: { hash: "tx", from: wallet }, quoteTokens: new Set(), logs: [
      { ...base, data: "0x" }, { ...base, data: "invalid" },
      { ...base, topics: [...base.topics, "0x01"], data: "0x01" }, { ...base, data: "0x02" },
    ] });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.amount).toBe(2n);
  });
});
