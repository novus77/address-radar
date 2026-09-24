import type { TraderLifecycle } from "@address-radar/domain";
import type { AddressSignalEvidence, AddressEvidenceSourceState } from "./evidence.js";

export interface SignalTraderProfile {
  readonly entityId: string;
  readonly lifecycle: TraderLifecycle;
  readonly mapped: boolean;
  readonly monitoringEnabled: boolean;
  readonly fomoMonitoringEnabled: boolean;
  readonly onchainMonitoringEnabled: boolean;
}

export interface TokenAggregationState {
  readonly broadcastCount: number;
  readonly consumedEvidenceIds: readonly string[];
  readonly consumedEconomicKeys: readonly string[];
}

export interface TokenEvaluationInput {
  readonly chain: string; readonly tokenAddress: string; readonly action: "observe" | "broadcast" | "rebroadcast";
  readonly signalFamily: "NEW_TOKEN_DISCOVERY" | "OLD_TOKEN_MOVEMENT" | null;
  readonly lifecycleStage: string; readonly score: number; readonly participantCount: number;
  readonly totalBuyUsd: number; readonly sourceState: AddressEvidenceSourceState; readonly windowMs: number;
  readonly missingConditions: readonly string[]; readonly updatedAt: number;
}

export interface TokenAggregationRepository {
  saveAddressSignalEvidence(chain: string, tokenAddress: string, evidence: AddressSignalEvidence): void;
  addressSignalEvidenceForToken(chain: string, tokenAddress: string, since: number): readonly AddressSignalEvidence[];
  tokenAggregationState(chain: string, tokenAddress: string): TokenAggregationState | null;
  traderSignalProfile(entityId: string): SignalTraderProfile | null;
  upsertTraderSignalProfile(input: {
    readonly entityId: string;
    readonly monitoringEnabled: boolean;
    readonly fomoMonitoringEnabled: boolean;
    readonly onchainMonitoringEnabled: boolean;
    readonly updatedAt: number;
  }): void;
  saveTokenEvaluation(input: TokenEvaluationInput): void;
  commitTokenBroadcast(input: {
    readonly chain: string; readonly tokenAddress: string; readonly expectedPreviousBroadcastCount: number;
    readonly strategyVersion: string; readonly score: number; readonly triggeredAt: number;
    readonly evidenceIds: readonly string[]; readonly economicKeys: readonly string[];
    readonly evaluation: TokenEvaluationInput; readonly payload: unknown; readonly publicSignal: unknown;
  }): { readonly inserted: boolean; readonly broadcastNumber: number };
}
