import {
  createSourceObservation,
  type SourceExtractionMode,
  type SourceId,
  type SourceObservation,
  type SourceObservationWriteResult,
  type TraderEvent,
} from "@address-radar/domain";

import type { TradeEventRepository } from "./types.js";

export interface SourceObservationRepository {
  saveObservation(observation: SourceObservation): SourceObservationWriteResult;
}

export interface SourceObservationIngestorOptions {
  readonly sourceLedger: SourceObservationRepository;
  readonly eventRepository: TradeEventRepository;
}

export interface SourceObservationIngestInput {
  readonly events: readonly TraderEvent[];
  readonly extractionMode: SourceExtractionMode;
  readonly provenance?: Readonly<Record<string, unknown>>;
}

export interface SourceObservationIngestResult {
  readonly observationsInserted: number;
  readonly eventsInserted: number;
  readonly duplicateObservations: number;
  readonly duplicateEvents: number;
}

function sourceIdForEvent(event: TraderEvent, extractionMode: SourceExtractionMode): SourceId {
  if (extractionMode === "replay") return "journal_replay";
  if (event.source === "fomo_stream") return "fomo_feed";
  if (event.source === "fomo_token_history") return "fomo_token_page";
  if (event.source === "onchain_wallet") return event.chain === "solana" ? "rpc_solana" : "rpc_evm";
  return "manual";
}

function confidenceForEvent(event: TraderEvent, extractionMode: SourceExtractionMode): number {
  if (extractionMode === "replay") return 0.8;
  if (event.source === "onchain_wallet") return 0.9;
  if (event.source === "fomo_stream" || event.source === "fomo_token_history") return 0.85;
  return 0.75;
}

export function sourceObservationForTraderEvent(
  event: TraderEvent,
  extractionMode: SourceExtractionMode,
  provenance: Readonly<Record<string, unknown>> = {},
): SourceObservation {
  return createSourceObservation({
    source: sourceIdForEvent(event, extractionMode),
    sourceEventId: event.eventId,
    chain: event.chain,
    observedAt: event.occurredAt,
    collectedAt: event.collectedAt,
    payloadVersion: 1,
    payload: event,
    extractionMode,
    confidence: confidenceForEvent(event, extractionMode),
    provenance: { originalSource: event.source, ...provenance },
  });
}

export function createSourceObservationIngestor(options: SourceObservationIngestorOptions) {
  return Object.freeze({
    async ingest(input: SourceObservationIngestInput): Promise<SourceObservationIngestResult> {
      let observationsInserted = 0;
      let eventsInserted = 0;
      let duplicateObservations = 0;
      let duplicateEvents = 0;

      for (const event of input.events) {
        const observation = sourceObservationForTraderEvent(event, input.extractionMode, input.provenance);
        const writeResult = options.sourceLedger.saveObservation(observation);
        if (writeResult.status === "conflict") continue;
        if (writeResult.status === "inserted") observationsInserted += 1;
        else duplicateObservations += 1;

        if (options.eventRepository.insertTraderEvent(event).inserted) eventsInserted += 1;
        else duplicateEvents += 1;
      }

      return Object.freeze({ observationsInserted, eventsInserted, duplicateObservations, duplicateEvents });
    },
  });
}
