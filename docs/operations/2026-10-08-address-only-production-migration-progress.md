# Address-only production migration: native progress

## Scope and authority

The approved migration retains confirmed wallet identities, account/entity links,
profiles and monitoring policies. Legacy tokens, trades, historical prices,
evidence and jobs are excluded. Existing SQLite data and backups remain retained.
The user has authorized implementation, tests and production migration operations
without repeated minor approval requests. Gateway delivery must remain disabled.

## Completed native operations

- Measured six real compiled service-module imports under a bounded native cgroup.
  Peak memory was 195,018,752 bytes. This proves module startup only, not steady-state
  service capacity or activation readiness.
- Installed minimum runtime grants in the production PostgreSQL schema. Protected
  migration authority tables remain non-writable to business roles.
- Provisioned six distinct local SCRAM credentials in root-private server files.
  Added exact database/role IPv4-loopback HBA rules; no remote authentication rule
  was introduced. An independent restore timer guarded the operation.
- All six roles passed the actual compiled business driver's connection identity,
  minimum privilege, generation and schema version/fingerprint probes. Credentials
  were not exported. No business service was switched or restarted by this step.
- Corrected discovery error attribution: exhausted query budgets no longer assert
  an observed FOMO process replacement. Surface queries reserve the original
  budget's final three protected-process checks. Unknown observations still fail
  closed; no discovery limit was increased.
- Discovery regression tests passed: 32 existing tests and four new tests.

## Native evidence

Authentication receipt directory:
`/var/lib/address-radar-maintenance-tools/address-only-runtime-auth-2d77b313f6e82f20`

Latest discovery directory:
`/var/lib/address-radar-maintenance-tools/scope-discovery-607060bb8675d5e7`

The corrected discovery completed 32 commands in 1,698 milliseconds. All three
protected FOMO process identities were stable. System unit, unit-file, timer, job
and session listings parsed completely. This is discovery, not a writer fence.

## Remaining blockers and implementation order

1. Finish native scope observation without asserting completeness from a truncated
   scan. A separate fresh measurement counted 177 processes, exceeding the
   discovery kernel ceiling of 128. The observed-unit metadata ceiling of eight
   also prevented full coverage. Any revised resource policy needs explicit bounds,
   tests and actual complete measurements; do not silently truncate or approve.
2. Correct the session-property query contract. Native `loginctl` returned an empty
   successful response for a comma-separated property argument. A short-lived SSH
   session also disappeared between listing and observation; distinguish these
   cases from an identity mismatch. Inactive, unobserved user managers need a
   measured disposition rather than fabricated active-manager coverage.
3. Install the production-specific compatibility collector and protected authority
   registry with current code hashes. The private rehearsal entry is not a
   substitute for production evidence.
4. Close all approved writer/admission surfaces, preserve FOMO login/collector/noVNC
   process identities, and prove no writable SQLite FD or mapping remains.
5. Capture the final address-only snapshot while fenced. Recompute import plan,
   cohort digest and operation identifiers; the earlier 216-wallet snapshot is not
   the final capture.
6. Import the reviewed cohort and first-write marker in the same parent transaction.
   Independently verify identity/body parity before formal service startup.
7. Verify production console routing, future-only monitoring cursors, provider
   contracts and durable fact writes. Switch services only with valid startup
   evidence and a PostgreSQL-preserving rollback path.
8. Accept a real fresh address-channel event end to end with delivery disabled.

## Completion status

**Migration incomplete.** Runtime authentication is installed and verified, but
no final production address import, backend cutover or fresh-event acceptance was
performed in this stage. Do not describe the isolated import rehearsal or six-role
connection probes as completed production migration.

## Follow-up: corrected native observation contracts

Individual `loginctl --property` arguments now replace the unsupported combined
property query. An inactive approved manager is accepted as an inactive observation
only when its UID was not observed in global manager or session listings. Observed
inactive managers remain unresolved.

The production discovery profile now explicitly permits 64 commands and 256
processes, with at most 32 additional service metadata queries. These changes are
limited to read-only discovery; the native writer fence has not been relaxed.
Original operation time, output size, total FD and maps-byte budgets remain.

The native report at
`/var/lib/address-radar-maintenance-tools/scope-discovery-adcb4402014ab15e`
completed 37 commands in 1,815 milliseconds. Session, user-manager and service
metadata coverage were complete; all three protected FOMO identities were stable.
The kernel scan examined 184 processes but remained partial: the Chrome process
had approximately 685 descriptors, above the unchanged per-process limit of 256,
and several transient processes exited during observation. Neither case is treated
as a successful writer fence. The browser was not stopped.

Validation: 42 Python discovery tests passed; the complete Vitest suite passed
337 files / 2,725 tests, with 25 files / 107 tests skipped. Automation and the
PostgreSQL service-entry TypeScript checks passed. The pnpm wrapper attempted an
unwanted dependency-install path and refused for lack of a TTY; the successful
suite was executed directly through the already installed Vitest entrypoint.

The production target still has no final address import or backend cutover.
The remaining work includes the bounded FD scan, protected production collectors,
writer/admission closure, fresh seed capture, atomic first-write receipt, independent
parity and actual PostgreSQL service/fresh-event acceptance.
