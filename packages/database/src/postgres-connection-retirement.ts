import { Client } from 'pg';

/** Physical permits outlive pg-pool bookkeeping and are never released by an error callback alone. */
export function createPostgresConnectionGate(maximum: number) {
  if (!Number.isSafeInteger(maximum) || maximum <= 0) throw new Error('Invalid physical connection limit');
  let active = 0;
  interface Waiter { grant(): void }
  const waiting = new Set<Waiter>();
  const empty = new Set<() => void>();
  const pulse = () => {
    while (active < maximum && waiting.size) waiting.values().next().value!.grant();
    if (active === 0) for (const done of [...empty]) done();
  };
  return Object.freeze({
    statistics: () => ({ active, waiting: waiting.size, emptyWaiters: empty.size }),
    acquire(timeoutMs: number, signal: AbortSignal): Promise<() => void> {
      return new Promise((resolve, reject) => {
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const cleanup = () => { waiting.delete(waiter); signal.removeEventListener('abort', aborted); if (timer) clearTimeout(timer); };
        const fail = (reason: string) => {
          if (settled) return;
          settled = true; cleanup(); reject(new Error(reason));
        };
        const aborted = () => fail('POSTGRES_CONNECTION_ACQUIRE_ABORTED');
        const waiter: Waiter = { grant() {
          if (settled) return;
          settled = true; cleanup(); active++;
          let released = false;
          resolve(() => { if (!released) { released = true; active--; pulse(); } });
        } };
        if (signal.aborted) { aborted(); return; }
        signal.addEventListener('abort', aborted, { once: true });
        if (active < maximum) waiter.grant();
        else {
          waiting.add(waiter);
          timer = setTimeout(() => fail('POSTGRES_CONNECTION_RETIREMENT_TIMEOUT'), timeoutMs);
        }
      });
    },
    drained(): Promise<void> {
      if (active === 0) return Promise.resolve();
      return new Promise(resolve => { const done = () => { empty.delete(done); resolve(); }; empty.add(done); });
    },
  });
}

export function createPostgresRetirementClient(maximum: number, timeoutMs: number): Readonly<{
  Client: typeof Client;
  drained(): Promise<void>;
  statistics(): { active: number; waiting: number; emptyWaiters: number };
}> {
  const gate = createPostgresConnectionGate(maximum);
  class RetirementClient extends Client {
    private readonly acquisition = new AbortController();
    private physicalRelease: (() => void) | undefined;
    private endedPhysically = false;
    private attempted = false;
    constructor(...args: ConstructorParameters<typeof Client>) {
      super(...args);
      // Installed before native connect: handshake failures and early end are covered too.
      this.once('end', () => {
        this.endedPhysically = true;
        this.acquisition.abort();
        this.physicalRelease?.(); this.physicalRelease = undefined;
      });
    }
    connect(): Promise<Client>;
    connect(callback: ((error: Error) => void) | ((error: null, client: Client) => void)): void;
    connect(callback?: ((error: Error) => void) | ((error: null, client: Client) => void)): Promise<Client> | void {
      const work = async () => {
        if (this.attempted) throw new Error('PostgreSQL connection attempt already started');
        this.attempted = true;
        const release = await gate.acquire(timeoutMs, this.acquisition.signal);
        if (this.acquisition.signal.aborted || this.endedPhysically) { release(); throw new Error('POSTGRES_CONNECTION_ACQUIRE_ABORTED'); }
        this.physicalRelease = release;
        try {
          await new Promise<void>((resolve, reject) => {
            super.connect((error: Error | null) => { if (error) reject(error); else resolve(); });
          });
        } catch (error) {
          // A rejected handshake can still have a live socket. Request close but retain its permit until end.
          void this.end().catch(() => undefined);
          throw error;
        }
        return this;
      };
      const promise = work();
      if (callback) {
        const notify = callback as (error: Error | null, client?: Client) => void;
        void promise.then(client => notify(null, client), (error: Error) => notify(error));
        return;
      }
      return promise;
    }
    end(): Promise<void>;
    end(callback: () => void): void;
    end(callback?: () => void): Promise<void> | void {
      this.acquisition.abort();
      // Never register a new end waiter here: release(error) may follow an already-observed end.
      if (callback) { super.end(callback); return; }
      return super.end();
    }
  }
  return Object.freeze({ Client: RetirementClient, drained: gate.drained, statistics: gate.statistics });
}
