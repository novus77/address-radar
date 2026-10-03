# Bounded Peak Fanout and Opportunity Reconciliation

## Guarantees

Publish immutable peak evidence and its fanout intent in one transaction. Each peak revision has one durable job, cursor and fenced lease. Dispatch only related samples whose 30-day windows overlap the evidence. Commit sample wakeup requests and cursor advancement together. Never skip a locked sample while advancing beyond it: bounded database lock/statement timeouts abort that page, preserving the previous committed position. New pages rotate by due time; duplicate source refreshes do not reopen completed fanout.

Reconciliation repairs missing initial sample work and missing fanout intents from stored, available facts. It does not call historical APIs or create clock-only opportunity requests. The approved five-minute reconciliation cadence is exposed as a constant, not started at module import. Limits, leases and a live clock are caller supplied. Final lease checks prevent a page from confirming progress after expiry. Query output and write batches are bounded; the missing-intent scan also relies on database statement budgets, not a promise of constant scan cost.

Samples committed after an older fanout finished are independently admitted by the sample outbox. Their first evaluation reads all relevant persisted peaks. This preserves observed late replay without restarting old fanout or launching historical buyer discovery. Revised executions still require authorized replacement and its matching sample work intent; this stage does not approve revisions or merge identities.

## Acceptance

Run `scripts/verify-postgres-opportunity-fanout-acceptance.ts` after building with the explicit loopback `_test` URL in `ADDRESS_RADAR_POSTGRES_ACCEPTANCE_URL` and delivery false. Five synthetic verified purchases exercise two peak revisions, bounded pages, expired-lease reclaim, a lost producer wakeup, late sample admission and unchanged repeated reconciliation. All temporary fixture data is rolled back; interruption tests verify rollback before cursor acknowledgement.

The runtime-facing processing adapter separates claim and page transactions. The isolated fixture composes its repository calls inside one rolled-back test transaction; it does not prove long-running runtime throughput or multi-client fanout stress. Production timer/dispatcher wiring, market provider validation and budget configuration, permanent schema activation, execution-revision authorization, stable-capability/admission projection and real-source coverage remain separate gates. Existing business services, SQLite, release pointer, paused FOMO and disabled delivery remain unchanged.
