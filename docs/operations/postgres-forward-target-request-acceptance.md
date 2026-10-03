# Forward target operator and independent HTTP acceptance

## Scope

The `/forward-targets` page is a separate operator surface. It uses the existing authenticated target control extension, not the legacy business writer. Serving static assets does not activate that extension. The production CLI remains unchanged and returns `forward_target_controls_disabled` until a separately approved composition enables it.

Credentials remain in page memory. Requests never accept actor identity or permissions from the client. Identity hydration only uses the existing verified registry source. Manual radar grants and revocations are explicit, audited commands; labels and priority do not grant eligibility. All other signal gates remain required. Revoking manual authorization does not erase independently acquired system capability or stop monitoring.

The UI shows the last hydrated snapshot, not continuous live identity verification. Registry counts are page counts, not total coverage. Candidate and full thirty-day capability detail remain separate follow-up work. No FOMO browser, follow action, new account, live capture, delivery or automatic retries are started by this surface.

## Independent request proof

Run the built `scripts/verify-postgres-forward-target-request-acceptance.ts` with an explicit isolated loopback PostgreSQL acceptance URL and `ADDRESS_RADAR_GATEWAY_DELIVERY_ENABLED=false`. Use one dedicated connection and an initially empty temporary namespace.

The fixture schema and synthetic identity are committed only to session-local TEMP tables. Unlike the earlier outer-transaction acceptance, the HTTP server runs outside the setup transaction. Every command uses the real PostgreSQL unit of work, independently commits or rolls back, and is checked from a later transaction.

Verified conditions:

- A committed manual grant and revocation are visible in subsequent independent transactions.
- Immutable retry does not duplicate the audit event or change intent.
- Changed command contents under the same ID return a conflict.
- An injected exception during intent persistence rolls back the event, head and intent together.
- The same failed command can subsequently commit once after retry.
- An anonymous HTTP mutation changes no audit rows.
- The backend session is fenced and the exact owned temporary table inventory is cleaned up.
- Operator assets are served; business activation and live-source coverage remain false.

This is synthetic single-session acceptance, not proof of concurrent multi-client HTTP writes, browser interaction coverage, live identity coverage, permanent schema readiness or business cutover. Earlier PostgreSQL repository concurrency proofs remain separate.

## Operator retry contract

Target selection and registry filtering use separate response revision fences. Selection, filter or session changes invalidate pending responses; an acknowledged write to a prior target remains acknowledged, but its state cannot replace the currently selected target. A failed follow-up refresh never causes an acknowledged authorization to be resubmitted automatically.

A failed or ambiguous command retains its ID in the current page session. Retrying the same entity, action and basis reuses that ID. A successful HTTP acknowledgement consumes the ID, even if the follow-up state read fails: operators must refresh state rather than create a second grant. Reloading or changing credentials loses the session-only retry cache; inspect the audit ledger before repeating an uncertain operation after that boundary.

## Deployment gate

Package this module, the CLI, the console public assets and existing automation readers into a unique `/opt/address-radar/operations` acceptance directory. Require checksum agreement, disabled gateway, sufficient disk space, unchanged business release and services, and the intentionally paused FOMO process. Do not migrate business schemas, switch releases, restart business services or resume capture. Final activation requires separate approval and continuous identity revalidation integration.
