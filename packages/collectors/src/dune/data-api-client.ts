import type {
  DuneDataApiClient,
  DuneDataApiClientOptions,
  DuneQueryResult,
  DuneSavedQueryOptions,
} from "./types.js";

type JsonObject = Readonly<Record<string, unknown>>;

export class DuneApiError extends Error {
  constructor(message: string, readonly status: number | null, readonly retryable: boolean) {
    super(message);
    this.name = "DuneApiError";
  }
}

export class DuneCreditLimitError extends DuneApiError {
  constructor() {
    super("Dune credit or billing limit reached", 402, false);
    this.name = "DuneCreditLimitError";
  }
}

export class DuneExecutionError extends Error {
  constructor(message: string, readonly executionId: string, readonly state: string) {
    super(message);
    this.name = "DuneExecutionError";
  }
}

export class DuneTimeoutError extends Error {
  constructor(readonly executionId: string | null, readonly timeoutMs: number) {
    super(`Dune execution timed out after ${timeoutMs}ms`);
    this.name = "DuneTimeoutError";
  }
}

const defaultSleep = async (durationMs: number, signal?: AbortSignal): Promise<void> => {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, durationMs);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    }, { once: true });
  });
};

const object = (value: unknown): JsonObject => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new DuneApiError("Malformed Dune response", null, false);
  return value as JsonObject;
};

const string = (value: unknown): string | null => typeof value === "string" && value.trim() ? value.trim() : null;
const number = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;
const terminalFailure = (state: string): boolean => ["QUERY_STATE_FAILED", "QUERY_STATE_CANCELLED", "QUERY_STATE_EXPIRED"].includes(state);

const errorMessage = (body: JsonObject): string => {
  const direct = string(body.error);
  if (direct) return direct;
  if (body.error && typeof body.error === "object") return string((body.error as JsonObject).message) ?? "Dune request failed";
  return string(body.message) ?? "Dune request failed";
};

export function createDuneDataApiClient(options: DuneDataApiClientOptions): DuneDataApiClient {
  const apiKey = options.apiKey.trim();
  if (!apiKey) throw new Error("Dune API key is required");
  const fetcher = options.fetch ?? globalThis.fetch;
  const baseUrl = (options.baseUrl ?? "https://api.dune.com/api/v1").replace(/\/$/, "");
  const timeoutMs = options.timeoutMs ?? 300_000;
  const pollIntervalMs = options.pollIntervalMs ?? 2_000;
  const retryDelayMs = options.retryDelayMs ?? 1_000;
  const maxRequestAttempts = options.maxRequestAttempts ?? 3;
  const maxPages = options.maxPages ?? 1_000;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  if (!(timeoutMs > 0) || !(pollIntervalMs > 0) || !(maxRequestAttempts > 0) || !(maxPages > 0)) throw new Error("Dune client limits must be positive");

  const request = async (path: string, init: RequestInit, signal?: AbortSignal): Promise<JsonObject> => {
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxRequestAttempts; attempt += 1) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      try {
        const requestInit: RequestInit = {
          ...init,
          headers: {
            "X-Dune-API-Key": apiKey,
            "Content-Type": "application/json",
            ...init.headers,
          },
          ...(signal ? { signal } : {}),
        };
        const response = await fetcher(`${baseUrl}${path}`, requestInit);
        const body = object(await response.json().catch(() => ({})));
        if (response.ok) return body;
        if (response.status === 402) throw new DuneCreditLimitError();
        const retryable = response.status === 429 || response.status >= 500;
        const failure = new DuneApiError(`Dune API returned HTTP ${response.status}: ${errorMessage(body)}`, response.status, retryable);
        if (!retryable || attempt === maxRequestAttempts) throw failure;
        lastError = failure;
      } catch (error) {
        if (error instanceof DuneCreditLimitError || (error instanceof DuneApiError && !error.retryable)) throw error;
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        lastError = error;
        if (attempt === maxRequestAttempts) {
          if (error instanceof DuneApiError) throw error;
          throw new DuneApiError("Dune API network request failed", null, true);
        }
      }
      await sleep(retryDelayMs * attempt, signal);
    }
    throw lastError instanceof Error ? lastError : new DuneApiError("Dune API request failed", null, true);
  };

  return Object.freeze({
    async runSavedQuery<Row extends Readonly<Record<string, unknown>>>(queryId: number, queryOptions: DuneSavedQueryOptions = {}): Promise<DuneQueryResult<Row>> {
      if (!Number.isSafeInteger(queryId) || queryId <= 0) throw new Error("Dune query ID must be a positive integer");
      const pageSize = queryOptions.pageSize ?? 1_000;
      if (!Number.isSafeInteger(pageSize) || pageSize <= 0 || pageSize > 100_000) throw new Error("Dune page size must be between 1 and 100000");
      const deadline = now() + timeoutMs;
      const body: Record<string, unknown> = {};
      if (queryOptions.parameters) body.query_parameters = queryOptions.parameters;
      if (queryOptions.performance) body.performance = queryOptions.performance;
      const started = await request(`/query/${queryId}/execute`, { method: "POST", body: JSON.stringify(body) }, queryOptions.signal);
      const executionId = string(started.execution_id);
      if (!executionId) throw new DuneApiError("Malformed Dune execution response", null, false);
      let state = string(started.state) ?? "QUERY_STATE_PENDING";

      while (state !== "QUERY_STATE_COMPLETED") {
        if (terminalFailure(state)) throw new DuneExecutionError(`Dune execution ended in ${state}`, executionId, state);
        if (now() >= deadline) throw new DuneTimeoutError(executionId, timeoutMs);
        await sleep(pollIntervalMs, queryOptions.signal);
        const status = await request(`/execution/${encodeURIComponent(executionId)}/status`, { method: "GET" }, queryOptions.signal);
        state = string(status.state) ?? "QUERY_STATE_UNKNOWN";
        if (terminalFailure(state)) throw new DuneExecutionError(errorMessage(status), executionId, state);
      }

      const rows: Row[] = [];
      const visitedOffsets = new Set<number>();
      let offset: number | null = 0;
      let pageCount = 0;
      let totalRowCount = 0;
      while (offset !== null) {
        if (pageCount >= maxPages || visitedOffsets.has(offset)) throw new DuneApiError("Dune pagination did not converge", null, false);
        if (now() >= deadline) throw new DuneTimeoutError(executionId, timeoutMs);
        visitedOffsets.add(offset);
        const page = await request(`/execution/${encodeURIComponent(executionId)}/results?limit=${pageSize}&offset=${offset}`, { method: "GET" }, queryOptions.signal);
        const pageState = string(page.state);
        if (pageState && terminalFailure(pageState)) throw new DuneExecutionError(errorMessage(page), executionId, pageState);
        const result = object(page.result);
        if (!Array.isArray(result.rows)) throw new DuneApiError("Malformed Dune result rows", null, false);
        rows.push(...result.rows.map(row => object(row) as Row));
        const metadata = result.metadata && typeof result.metadata === "object" ? result.metadata as JsonObject : {};
        totalRowCount = number(metadata.total_row_count) ?? rows.length;
        pageCount += 1;
        offset = number(page.next_offset);
      }
      return Object.freeze({ queryId, executionId, rows: Object.freeze(rows), pageCount, totalRowCount });
    },
  });
}
