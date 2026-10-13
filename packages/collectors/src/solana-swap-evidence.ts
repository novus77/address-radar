/** JSON-only readers support legacy/v0/v1; this does not enable transaction submission.
 * https://solana.com/upgrades/larger-transaction-sizes
 * https://github.com/solana-foundation/solana-dev-skill/blob/main/skills/solana-dev/references/transactions-v1.md
 * https://github.com/solana-foundation/transaction-v1-examples
 */
export const SOLANA_MAX_SUPPORTED_TRANSACTION_VERSION = 1;
export const SOLANA_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const SOLANA_USDT_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
export const SOLANA_WRAPPED_NATIVE_MINT = "So11111111111111111111111111111111111111112";

const STABLE_QUOTE_MINTS = new Set([SOLANA_USDC_MINT, SOLANA_USDT_MINT]);
const KNOWN_SWAP_PROGRAMS = new Set([
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
  "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzG3bC4iY6n",
  "675kPX9MHTjS2zt1qfr1NYHuzeTHKq9gXQDA8T3o1ut",
]);

export interface SolanaSwapTokenBalance {
  readonly accountIndex?: number;
  readonly mint: string;
  readonly owner?: string;
  readonly uiTokenAmount: {
    readonly uiAmount?: number | null;
    readonly amount?: string;
    readonly decimals?: number;
  };
}

export interface SolanaSwapInstruction {
  readonly programId?: string;
  readonly programIdIndex?: number;
  readonly accounts?: readonly (number | string)[];
}

export interface SolanaSwapTransaction {
  readonly version?: "legacy" | number;
  readonly transaction?: {
    readonly message?: {
      readonly accountKeys?: readonly (string | { readonly pubkey: string; readonly signer?: boolean; readonly source?: string })[];
      readonly instructions?: readonly SolanaSwapInstruction[];
      readonly addressTableLookups?: readonly unknown[];
      readonly transactionConfig?: {
        readonly computeUnitLimit: number | null;
        readonly heapSize: number | null;
        readonly loadedAccountsDataSizeLimit: number | null;
        readonly priorityFee: number | null;
      };
    };
  };
  readonly meta?: {
    readonly loadedAddresses?: { readonly writable: readonly string[]; readonly readonly: readonly string[] };
    readonly err?: unknown;
    readonly fee?: number;
    readonly preBalances?: readonly number[];
    readonly postBalances?: readonly number[];
    readonly preTokenBalances?: readonly SolanaSwapTokenBalance[];
    readonly postTokenBalances?: readonly SolanaSwapTokenBalance[];
    readonly innerInstructions?: readonly {
      readonly instructions?: readonly SolanaSwapInstruction[];
    }[] | null;
  } | null;
}

export interface SolanaAssetDelta {
  readonly accountIndex: number;
  readonly mint: string;
  readonly amount: number;
}

export interface SolanaSwapEvidence {
  readonly candidateDeltas: readonly SolanaAssetDelta[];
  readonly stableQuoteDeltas: readonly SolanaAssetDelta[];
  readonly wrappedNativeDeltas: readonly SolanaAssetDelta[];
  readonly nativeDelta: number;
  readonly knownSwapProgram: boolean;
  supportsSwap(candidate: SolanaAssetDelta): boolean;
}

// RPC projection uses nullable fields, not the sender's priorityFeeLamports spelling.
// Widths and heap bounds: https://github.com/solana-foundation/solana-improvement-documents/blob/main/proposals/0385-transaction-v1.md
export function isSupportedSolanaSwapTransaction(value: unknown): value is SolanaSwapTransaction {
  const object = (input: unknown): Record<string, unknown> | undefined =>
    input !== null && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : undefined;
  const transaction = object(value);
  if (!transaction) return false;
  const version = transaction.version;
  const message = object(object(transaction.transaction)?.message);
  if (version === undefined || version === "legacy" || version === 0) {
    // A config on a legacy/v0 response is not a usable v1 response in disguise.
    return !message || !Object.hasOwn(message, "transactionConfig");
  }
  if (version !== 1 || !message) return false;
  const config = object(message.transactionConfig);
  const fields = ["computeUnitLimit", "heapSize", "loadedAccountsDataSizeLimit", "priorityFee"] as const;
  if (!config || Object.keys(config).length !== fields.length) return false;
  for (const field of fields) {
    if (!Object.hasOwn(config, field)) return false;
    const number = config[field];
    if (number === null) continue;
    // Do not silently round a u64 JSON fee outside JavaScript's exact integer range.
    if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 0) return false;
    if (field !== "priorityFee" && number > 0xffff_ffff) return false;
    if (field === "heapSize" && (number < 32 * 1024 || number > 256 * 1024 || number % 1024 !== 0)) return false;
  }
  const keys = message.accountKeys;
  if (!Array.isArray(keys) || keys.length === 0 || keys.length > 64) return false;
  const addresses = new Set<string>();
  for (const key of keys) {
    const parsed = object(key);
    const address = typeof key === "string" ? key : parsed?.pubkey;
    if (typeof address !== "string" || address.length === 0 || addresses.has(address)) return false;
    if (parsed && parsed.source !== undefined && parsed.source !== "transaction") return false;
    addresses.add(address);
  }
  const validIndex = (index: unknown): index is number =>
    typeof index === "number" && Number.isSafeInteger(index) && index >= 0 && index < keys.length;
  const meta = object(transaction.meta);
  for (const field of ["preTokenBalances", "postTokenBalances"] as const) {
    const balances = meta?.[field];
    if (balances === undefined) continue;
    if (!Array.isArray(balances)) return false;
    for (const balance of balances) {
      if (!validIndex(object(balance)?.accountIndex)) return false;
    }
  }
  const validInstruction = (value: unknown): boolean => {
    const instruction = object(value);
    if (!instruction) return false;
    if (Object.hasOwn(instruction, "programIdIndex")) {
      // Compiled instructions carry numeric account indices, not parsed program addresses.
      if (Object.hasOwn(instruction, "programId") || Object.hasOwn(instruction, "parsed")
        || !validIndex(instruction.programIdIndex) || !Array.isArray(instruction.accounts)) return false;
      for (const index of instruction.accounts) if (!validIndex(index)) return false;
      return true;
    }
    // jsonParsed includes fully parsed objects and partially decoded address-account lists.
    if (typeof instruction.programId !== "string" || instruction.programId.length === 0) return false;
    if (instruction.accounts !== undefined) {
      if (!Array.isArray(instruction.accounts)) return false;
      for (const address of instruction.accounts) {
        if (typeof address !== "string" || address.length === 0) return false;
      }
    }
    return true;
  };
  if (message.instructions !== undefined) {
    if (!Array.isArray(message.instructions)) return false;
    for (const instruction of message.instructions) if (!validInstruction(instruction)) return false;
  }
  if (meta?.innerInstructions !== undefined && meta.innerInstructions !== null) {
    if (!Array.isArray(meta.innerInstructions)) return false;
    for (const group of meta.innerInstructions) {
      const instructions = object(group)?.instructions;
      if (!Array.isArray(instructions)) return false;
      for (const instruction of instructions) if (!validInstruction(instruction)) return false;
    }
  }
  if (message.addressTableLookups !== undefined
    && (!Array.isArray(message.addressTableLookups) || message.addressTableLookups.length !== 0)) return false;
  const loaded = object(transaction.meta)?.loadedAddresses;
  if (loaded !== undefined) {
    const addresses = object(loaded);
    if (!addresses || !Array.isArray(addresses.writable) || addresses.writable.length !== 0
      || !Array.isArray(addresses.readonly) || addresses.readonly.length !== 0) return false;
  }
  return true;
}

export function extractSolanaSwapEvidence(
  transaction: SolanaSwapTransaction | null,
  wallet: string,
): SolanaSwapEvidence {
  if (transaction !== null && !isSupportedSolanaSwapTransaction(transaction)) {
    throw new Error("Unsupported Solana transaction schema");
  }
  const tokenDeltas = tokenDeltasForWallet(transaction, wallet);
  const stableQuoteDeltas = tokenDeltas.filter((delta) => STABLE_QUOTE_MINTS.has(delta.mint));
  const wrappedNativeDeltas = tokenDeltas.filter((delta) => delta.mint === SOLANA_WRAPPED_NATIVE_MINT);
  const candidateDeltas = tokenDeltas.filter((delta) =>
    !STABLE_QUOTE_MINTS.has(delta.mint) && delta.mint !== SOLANA_WRAPPED_NATIVE_MINT);
  const nativeDelta = feeAdjustedNativeDelta(transaction, wallet);
  const knownSwapProgram = programIds(transaction).some((programId) => KNOWN_SWAP_PROGRAMS.has(programId));

  return Object.freeze({
    candidateDeltas: Object.freeze(candidateDeltas),
    stableQuoteDeltas: Object.freeze(stableQuoteDeltas),
    wrappedNativeDeltas: Object.freeze(wrappedNativeDeltas),
    nativeDelta,
    knownSwapProgram,
    supportsSwap(candidate: SolanaAssetDelta) {
      const sign = Math.sign(candidate.amount);
      if (sign === 0) return false;
      const opposingStable = stableQuoteDeltas.some((quote) => Math.sign(quote.amount) === -sign);
      if (opposingStable) return true;
      if (!knownSwapProgram) return false;
      const opposingNative = nativeDelta !== 0 && Math.sign(nativeDelta) === -sign;
      const opposingWrappedNative = wrappedNativeDeltas.some((quote) => Math.sign(quote.amount) === -sign);
      const opposingProgramLeg = tokenDeltas.some((delta) =>
        delta !== candidate
        && !STABLE_QUOTE_MINTS.has(delta.mint)
        && delta.mint !== SOLANA_WRAPPED_NATIVE_MINT
        && Math.sign(delta.amount) === -sign);
      return opposingNative || opposingWrappedNative || opposingProgramLeg;
    },
  });
}

function feeAdjustedNativeDelta(transaction: SolanaSwapTransaction | null, wallet: string): number {
  const keys = accountKeys(transaction);
  const walletIndex = keys.indexOf(wallet);
  if (walletIndex < 0) return 0;
  const rawLamports = (transaction?.meta?.postBalances?.[walletIndex] ?? 0)
    - (transaction?.meta?.preBalances?.[walletIndex] ?? 0);
  const fee = walletIndex === 0 ? transaction?.meta?.fee ?? 0 : 0;
  return (rawLamports + fee) / 1_000_000_000;
}

function programIds(transaction: SolanaSwapTransaction | null): string[] {
  const keys = accountKeys(transaction);
  const instructions = [
    ...(transaction?.transaction?.message?.instructions ?? []),
    ...(transaction?.meta?.innerInstructions ?? []).flatMap((group) => group.instructions ?? []),
  ];
  return instructions.flatMap((instruction) => {
    if (instruction.programId) return [instruction.programId];
    if (instruction.programIdIndex !== undefined && keys[instruction.programIdIndex]) {
      return [keys[instruction.programIdIndex]!];
    }
    return [];
  });
}

function accountKeys(transaction: SolanaSwapTransaction | null): string[] {
  const original = transaction?.transaction?.message?.accountKeys ?? [];
  const keys = original.map((key) => typeof key === "string" ? key : key.pubkey);
  // Raw v0 indices address static + writable lookup + readonly lookup keys. jsonParsed is already expanded.
  if (transaction?.version === 0 && original.every(key => typeof key === "string")) {
    const loaded = transaction.meta?.loadedAddresses;
    return [...keys,...(loaded?.writable ?? []),...(loaded?.readonly ?? [])];
  }
  return keys;
}

function tokenDeltasForWallet(
  transaction: SolanaSwapTransaction | null,
  wallet: string,
): SolanaAssetDelta[] {
  const balances = new Map<string, {
    accountIndex: number;
    mint: string;
    pre: number;
    post: number;
  }>();
  for (const item of transaction?.meta?.preTokenBalances ?? []) {
    if (item.owner !== wallet) continue;
    const key = balanceKey(item);
    balances.set(key, {
      accountIndex: item.accountIndex ?? 0,
      mint: item.mint,
      pre: tokenAmount(item),
      post: 0,
    });
  }
  for (const item of transaction?.meta?.postTokenBalances ?? []) {
    if (item.owner !== wallet) continue;
    const key = balanceKey(item);
    const previous = balances.get(key);
    balances.set(key, {
      accountIndex: item.accountIndex ?? previous?.accountIndex ?? 0,
      mint: item.mint,
      pre: previous?.pre ?? 0,
      post: tokenAmount(item),
    });
  }
  return [...balances.values()].flatMap((balance) => {
    const amount = balance.post - balance.pre;
    return amount === 0 ? [] : [{
      accountIndex: balance.accountIndex,
      mint: balance.mint,
      amount,
    }];
  });
}

function balanceKey(balance: SolanaSwapTokenBalance): string {
  return balance.accountIndex === undefined ? balance.mint : String(balance.accountIndex);
}

function tokenAmount(balance: SolanaSwapTokenBalance): number {
  if (balance.uiTokenAmount.uiAmount !== undefined && balance.uiTokenAmount.uiAmount !== null) {
    return balance.uiTokenAmount.uiAmount;
  }
  return Number(balance.uiTokenAmount.amount ?? 0) / 10 ** (balance.uiTokenAmount.decimals ?? 0);
}
