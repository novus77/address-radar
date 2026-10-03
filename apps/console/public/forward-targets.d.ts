export interface OperatorTargetKey {
  readonly entityId: string; readonly channel: "fomo" | "wallet";
  readonly subjectId: string; readonly walletFamily: "evm" | "solana" | null;
}
export interface OperatorRegistryCursor { readonly entityId: string; readonly subjectKey: string; }
export interface ForwardTargetOperatorClient {
  setToken(token: string): void;
  state(key: OperatorTargetKey): Promise<Record<string, unknown>>;
  hydrate(key: OperatorTargetKey): Promise<Record<string, unknown>>;
  registry(channel: "fomo" | "wallet", after?: OperatorRegistryCursor | null): Promise<Record<string, unknown>>;
  authorize(input: { entityId: string; action: "grant" | "revoke"; basisRef: string }): Promise<Record<string, unknown>>;
}
export function createForwardTargetOperatorClient(options: { fetch: typeof fetch; id?: () => string }): ForwardTargetOperatorClient;
export function createOperatorRequestFence(): { capture(): number; invalidate(): void; isCurrent(captured: number): boolean };
