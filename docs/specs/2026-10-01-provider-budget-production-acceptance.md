# Provider Budget Coordination: Production Acceptance

## Release and local verification

Release: `82052f9-provider-budget`. Previous release: `5763098-bounded-requests`.

The checkpoint passed 33 targeted tests, 790 unit tests, build, typecheck, package import smoke checks, module boundaries, and two desktop/mobile browser tests. Tests prove atomic logical budget reservation across independent database connections and current-minute accounting. They do not prove per-HTTP-page usage accounting.

## Production snapshot

Snapshot: 2026-10-01T10:25:12Z (18:25 China Standard Time).

All six services were active with NRestarts=0 and ADDRESS_RADAR_GATEWAY_DELIVERY_ENABLED=false. The current symlink pointed to `/opt/address-radar/releases/82052f9-provider-budget`. The last five minutes contained zero matching SQLite contention, invalid budget reservation, missing-table, or fatal log entries.

Disk available: 3,098,664,960 bytes. Prior approved archived-journal cleanup freed 114,257,920 bytes; business databases, WAL, events, backups, and rollback releases were retained. Disk headroom remains thin and requires monitoring.

## Progress and remaining limits

- Candidate evidence facts: 1,439.
- Distinct opportunity-v4 ability evaluations: 262.
- Early trade recovery completed: 1,702; pending: 410.
- Candidate evidence blocked: 1,888.
- Recovery closure satisfied: 2,174 of 5,743; pending: 3,037; terminal: 532.
- Runnable: 117; runnableDelta15m: +100; converging: false.
- Active oversized consumer history request manifests: zero.

Healthy services and successful deployment are not complete business-loop acceptance. Strict consumer coverage proof, source capability coverage, DefiLlama physical request boundaries, and durable partial-page recovery remain open. No reliable overall completion estimate is available.
