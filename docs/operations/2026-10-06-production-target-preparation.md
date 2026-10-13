# Production target preparation

## Observed state

Read-only inspection of `152.32.185.240` found PostgreSQL 16 cluster
`radaracceptance` listening on loopback port `5433`. Its non-template databases
are `postgres` and `address_radar_acceptance_test`. The application processes
did not expose PostgreSQL target configuration. No production PostgreSQL target
was identified by this inspection; this is not a claim about every possible
external database.

All six application services were active with zero automatic restarts. Gateway
delivery was `false` in each process. The active release remained
`4b48fc2-forward-token-code`. Inspection performed no remote mutations.

## Preparation boundaries

- Provision a separate production target; do not repurpose the acceptance database.
- Bind the target to its measured cluster identity, database, schema and generation.
- Follow the existing production role and resource contract. Resolve ownership
  compatibility with the installer before creating database objects.
- Restrict network access to loopback and use protected credential files.
- Refuse unknown existing objects rather than taking ownership implicitly.
- Keep candidate service configuration inactive until migration gates pass.
- Preserve SQLite, business events, backups and the current release.
- Do not manufacture reviewer or collector trust to satisfy readiness checks.

Production provisioning, full preservation verification, writer fencing,
production cutover and business activation are distinct checkpoints. Successful
creation of an empty target does not establish migration readiness.

## Local verification checkpoint

The following checks passed for the implementation checkpoint preceding final
host integration:

| Check | Result |
| --- | --- |
| Database test TypeScript configuration | Passed |
| Staged supervisor and host adapter tests | 65 passed |
| Expiry and cleanup helper tests | 59 passed |
| Import and staged parity targeted tests | 101 passed, 1 skipped |
| Full Vitest suite | 303 files passed, 25 skipped; 2676 tests passed, 107 skipped |

These are local tests, not Linux/root lifecycle acceptance or production data
parity evidence. Remaining integration includes one consistent producer cgroup
ownership contract, protected artifact provenance, actual continuous database
freeze measurements, native segment execution, and finalization under the
approved execution limits.

The user has authorized freezing the isolated rehearsal database for independent
verification. This authorization does not make the acceptance cluster a
production target, or assert that production trust configuration exists.

## Read-only provisioning preflight

A subsequent read-only inspection observed:

| Property | Observed value |
| --- | --- |
| Total RAM | 4104122368 bytes |
| Available RAM | 1325588480 bytes |
| Total swap | 2147479552 bytes |
| Free swap | 155648 bytes |
| Available filesystem space | 26934300672 bytes |
| Service manager | systemd 255 |
| Cgroup hierarchy | cgroup v2 |

The candidate `radarproduction` configuration and data directories, protected
production configuration directory, and provisioning journal directory were
absent. This observation is not an exclusive reservation; creation must recheck
collisions immediately before any mutation.

Nearly exhausted swap does not establish current swapping or memory pressure.
It does require measured capacity before running a second workload. Preparing an
empty, inactive target is distinct from approving concurrent application pools,
importer memory, PostgreSQL buffers, WAL growth and backup operations. No
production capacity fingerprint may be synthesized from these point-in-time
free-space values.

The provisioning contract creates seven NOLOGIN identities and retains the
migrator's database/schema ownership boundary. The business namespace must
remain absent until the existing authenticated installer creates it. Candidate
credentials and configuration must remain private and inactive. Unknown existing
objects and ambiguous partial operations require reconciliation, not adoption,
automatic DROP, secret rotation or privilege escalation.
