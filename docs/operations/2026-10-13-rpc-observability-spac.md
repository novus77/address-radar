# RPC Failure Observability SPAC and Implementation Plan

## Approved goal

Improve attribution of existing RPC failures for Solana and Base without changing database schema, source/operator pairing, budgets, retry decisions, cooldown policy, acquisition eligibility or business rules. Do not contact or bypass the denied PublicNode endpoint. This is instrumentation, not permission to activate new sources or deploy.

## Confirmed code and evidence gaps

The durable fetch observer currently recognizes only configured Solana-origin methods. The execution diagnostic sink emits a fixed Solana chain. HTTP 429 observations omit HTTP status; local budget rejection observations omit retry timing. Bounded production logs distinguish upstream rate-limit classification from local cooldown, but do not establish a current quota-exhaustion response or Base's initiating failure.

## Exact implementation scope

Modify apps/automation/src/postgres-service-fact-adapters.ts, apps/automation/src/postgres-wallet-rpc-producer.ts and scripts/postgres-service-entry.ts, together with apps/automation/test/postgres-service-fact-adapters.test.ts, apps/automation/test/postgres-wallet-rpc-producer.test.ts and scripts/test/postgres-service-entry.test.ts. Add a narrowly scoped helper/test only if required to keep closed diagnostic metadata separate from acquisition behavior; document any scope addition. Do not edit production configuration or migrations.

## Diagnostic contract

Keep existing reason codes, JSON-RPC code field, subcategory and transport semantics. Add optional bounded HTTP status, configured chain/provider identity and safe retry timing as diagnostic-only metadata. HTTP status and JSON-RPC error code remain separate. Unknown or absent values remain absent; HTTP 429 alone never becomes a quota-exhaustion assertion.

Bind identity to existing approved runtime source/replay configuration and the durable provider contract, not endpoint-name heuristics, request parameters or remote error messages. Support the actual configured EVM methods used by Base alongside existing Solana methods. Preserve compatibility for existing Solana observer callers. Ambiguous/untrusted context must not create a new attribution or change request execution.

Logs must contain only closed metadata: validated chain, provider identifier, method, status, reason classification, transport and safe timing. No full URLs, API keys, credentials, wallet/request parameters, transaction payloads, response bodies or arbitrary error text. Reject accessor/proxy-derived metadata where existing interfaces already enforce descriptor safety. Observer exceptions must remain isolated from transport/acquisition results.

Local cooldown events have no fabricated HTTP status; they retain budgetReason and distinguish local protection from remote rejection. Existing rate-limit parsing, Retry-After clamping, lease debit/release, SQL and pacing decisions must remain unchanged. Additional classification is observational only.

## Implementation sequence

1. Extend diagnostic types and trusted contextual binding; preserve old reason/transport semantics.
2. Carry HTTP/JSON-RPC metadata and existing retry/cooldown timing through the durable fetch observer, including approved Base context.
3. Update the sink to validate and emit the optional closed fields with a truthful chain rather than a fixed chain.
4. Add regressions for Solana and Base HTTP 429/401/403, HTTP-200 JSON-RPC errors, local cooldown without a fetch, safe timing, untrusted metadata, observer exceptions and unchanged budget/cooldown operations.
5. Run targeted tests and dedicated/project type checks, then full regression and compiled smoke tests. Run an offline loopback or existing isolated transport test through actual adapters and sink; no live RPC verification is required for this scope.
6. Independent review verifies metadata privacy, configuration binding and unchanged acquisition/budget/retry semantics. Record actual results and any skips; do not equate offline instrumentation evidence with production source acceptance.

## Acceptance boundary

A controlled Base failure can be attributed to Base/provider with the actual status, while a controlled Solana failure remains correctly attributed. Local cooldown is observable without an upstream call or invented remote error. Existing callbacks and acquisition/defer behavior remain compatible. All diagnostics are sanitized and cannot grant authority or business eligibility. Production access clearance, fresh source approval, final material binding, release activation and live closed-loop acceptance remain separate incomplete gates.

## Initial implementation checkpoint

The implementation is limited to the six planned source/test files; no additional source file or database table was added. It includes trusted source/replay context binding, separate HTTP status and JSON-RPC code, Base-method observation, local retryAt diagnostics and closed sink metadata.

Initial targeted tests reported 445 passed and 3 failed. Two failures are an overly broad privacy assertion matching the valid category invalid_params; the remaining failure is missing sources configuration in the new loopback fixture. Offline integration is therefore not yet accepted. The initial script type check used stale referenced automation declarations; rebuilding with tsc -b apps/automation and then rerunning scripts/tsconfig.postgres-services.json succeeded without a source correction.

Independent review identified an additional observer boundary: observeBudget performs instanceof before rejecting Proxy objects, allowing a getPrototypeOf trap to execute and potentially replace the original rejection. Consolidated permission has been requested to correct the fixture/assertions and order this guard safely, with a no-trap/original-rejection regression. No correction to those remaining issues, full regression, deployment or live RPC acceptance is claimed at this checkpoint.

## Final engineering acceptance: 2026-10-13

After the user explicitly resumed and approved the deferred corrections, privacy assertions were narrowed to actual JSON params fields, the loopback deployment fixture received its required sources block, and observeBudget now rejects Proxy objects before instanceof. The added regression verifies that no prototype trap runs, the original rejection identity is preserved, no upstream fetch occurs, and no budget debit/cooldown/release write is attempted on that rejection path.

Fresh targeted validation: 449 tests passed across the adapter, Solana producer and root-entry suites. The real local HTTP loopback test covers source Solana, source Base and reviewed Base replay through actual durable adapters and the root log sink; its database port is synthetic. Reference build and all configured project/script type checks passed. Full Vitest: 4,398 passed / 206 skipped. Compiled artifact smoke tests: 68 passed. Independent review closed the prior Proxy finding and found no further defect in the approved corrections.

A first patch application failed at Ruby parsing before any file changes; the approved patch was then applied successfully. No source change beyond the approved corrections was required for that application failure. This record supersedes the initial failed-test checkpoint for engineering acceptance only.

This completes the approved instrumentation engineering scope. No schema, request allocation, retry policy, admission rule, provider/operator pairing or production configuration was changed. No Git commit, deployment, live PublicNode request or production service restart occurred. Production Base cooldown attribution still requires a separately authorized release deployment and live observation; the passing offline test is not production database, source-access or closed-loop proof.
