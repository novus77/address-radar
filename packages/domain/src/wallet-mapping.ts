import { normalizeFomoHandle } from "./identity.js";
import type { ChainFamily } from "./model.js";

export interface ManualWalletMapping {
  readonly family: ChainFamily;
  readonly address: string;
}

export const normalizeManualWalletMapping = (mapping: ManualWalletMapping): ManualWalletMapping => {
  if (mapping.family === "evm") {
    if (!/^0x[0-9a-fA-F]{40}$/.test(mapping.address)) throw new Error("Invalid EVM wallet address");
    return Object.freeze({ family: "evm", address: mapping.address.toLowerCase() });
  }
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mapping.address)) throw new Error("Invalid Solana wallet address");
  return Object.freeze({ family: "solana", address: mapping.address });
};

export const normalizeManualResolutionHandle = (handle: string): string => normalizeFomoHandle(handle);
