import type { FetchLike } from "../types.js";

export type DuneQueryParameter = string | number | boolean | null;
export type DuneQueryParameters = Readonly<Record<string, DuneQueryParameter>>;
export type DunePerformanceTier = "medium" | "large";

export interface DuneSavedQueryOptions {
  readonly parameters?: DuneQueryParameters;
  readonly performance?: DunePerformanceTier;
  readonly pageSize?: number;
  readonly signal?: AbortSignal;
}

export interface DuneQueryResult<Row extends Readonly<Record<string, unknown>>> {
  readonly queryId: number;
  readonly executionId: string;
  readonly rows: readonly Row[];
  readonly pageCount: number;
  readonly totalRowCount: number;
}

export interface DuneSavedQueryPageOptions extends DuneSavedQueryOptions {
  readonly executionId?: string | null;
  readonly offset?: number | null;
}

export interface DuneQueryPage<Row extends Readonly<Record<string, unknown>>> {
  readonly queryId: number;
  readonly executionId: string;
  readonly rows: readonly Row[];
  readonly nextOffset: number | null;
  readonly totalRowCount: number;
}

export interface DuneDataApiClient {
  runSavedQuery<Row extends Readonly<Record<string, unknown>> = Readonly<Record<string, unknown>>>(
    queryId: number,
    options?: DuneSavedQueryOptions,
  ): Promise<DuneQueryResult<Row>>;
  runSavedQueryPage<Row extends Readonly<Record<string, unknown>> = Readonly<Record<string, unknown>>>(
    queryId: number,
    options?: DuneSavedQueryPageOptions,
  ): Promise<DuneQueryPage<Row>>;
}

export interface DuneDataApiClientOptions {
  readonly apiKey: string;
  readonly fetch?: FetchLike;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly retryDelayMs?: number;
  readonly maxRequestAttempts?: number;
  readonly maxPages?: number;
  readonly now?: () => number;
  readonly sleep?: (durationMs: number, signal?: AbortSignal) => Promise<void>;
}
