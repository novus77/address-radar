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
}

export interface SolanaSwapTransaction {
  readonly transaction?: {
    readonly message?: {
      readonly accountKeys?: readonly (string | { readonly pubkey: string; readonly signer?: boolean })[];
      readonly instructions?: readonly SolanaSwapInstruction[];
    };
  };
  readonly meta?: {
    readonly err?: unknown;
    readonly fee?: number;
    readonly preBalances?: readonly number[];
    readonly postBalances?: readonly number[];
    readonly preTokenBalances?: readonly SolanaSwapTokenBalance[];
    readonly postTokenBalances?: readonly SolanaSwapTokenBalance[];
    readonly innerInstructions?: readonly {
      readonly instructions?: readonly SolanaSwapInstruction[];
    }[];
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

export function extractSolanaSwapEvidence(
  transaction: SolanaSwapTransaction | null,
  wallet: string,
): SolanaSwapEvidence {
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
  return (transaction?.transaction?.message?.accountKeys ?? [])
    .map((key) => typeof key === "string" ? key : key.pubkey);
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
