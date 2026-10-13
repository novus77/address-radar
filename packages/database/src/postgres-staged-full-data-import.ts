import {
  runFullDataPreservationImport,
  type FullDataPreservationImportInput,
  type FullDataPreservationSegmentOptions,
  type FullDataPreservationSegmentResult,
} from "./postgres-full-data-import.js";

export type StagedFullDataPreservationSegmentInput = FullDataPreservationImportInput & FullDataPreservationSegmentOptions;
export type { FullDataPreservationSegmentResult } from "./postgres-full-data-import.js";

/** Validates the entire source on every call, then reconciles/imports only selected chunks.
 * Selection follows manifest table order and each table's chunk order. Only successful
 * native UOW acknowledgements advance nextChunkIndex. Unknown commits propagate.
 * This API neither freezes the target nor grants parity, completion or business eligibility.
 */
export function importStagedFullDataPreservationSegment(input: StagedFullDataPreservationSegmentInput): Promise<FullDataPreservationSegmentResult> {
  return runFullDataPreservationImport(input, {
    sessionId: input.sessionId, selection: input.selection, closeReserveMs: input.closeReserveMs,
  });
}
