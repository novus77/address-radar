import { DatabaseSync } from "node:sqlite";

const path = process.argv[2];
if (!path) throw new Error("A database path is required");
const database = new DatabaseSync(path, { readOnly: true });
try {
  const present = database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='token_market_snapshots'").get();
  if (!present) throw new Error("Market snapshot schema is unavailable");
  const suspect = database.prepare(`
    SELECT snapshot_id AS snapshotId,token_id AS tokenId,observed_at AS storedObservedAt,
      json_extract(payload,'$.observedAt') AS providerObservedAt
    FROM token_market_snapshots
    WHERE source='dexscreener' AND json_valid(payload)
      AND ABS(observed_at - ROUND((julianday(json_extract(payload,'$.observedAt')) - 2440587.5) * 86400000)) > 1
    ORDER BY snapshot_id LIMIT 1000
  `).all();
  console.log(JSON.stringify({ auditedAt: Date.now(), readOnly: true,
    maximumReportedRows: 1000, exhaustive: suspect.length < 1000,
    suspect, repairApplied: false }, null, 2));
} finally { database.close(); }
