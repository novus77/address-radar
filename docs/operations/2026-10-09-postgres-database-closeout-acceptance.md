# PostgreSQL Database Closeout Acceptance

Date: 2026-10-09. Local timestamps use Asia/Shanghai (UTC+08:00).

## Acceptance boundary

The address-only PostgreSQL migration, native schema-and-data backup, independent data restore, daily backup scheduling, daily read-only retention preflight, and isolated minimum roles/ACL reconstruction have the evidence recorded below. Database closeout is PASS for this bounded scope. This is not full-system completion, full disaster-recovery acceptance, or proof of a complete radar business loop.

No production business data was deleted by these backup, restore, or retention-preflight operations. Automatic retention deletion is not enabled. Proof purge and exact deletion execution remain deferred.

## Address-only committed migration

The accepted PostgreSQL business schema is version 3, in database `address_radar`, schema `address_radar_business`.

- Generation: `production-20261006-v1`.
- Schema fingerprint: `b6ef9fd898f7b88d4942275567aca04360c55737f7fd2eecbae9baa8006df383`.
- Imported address cohort: 216 addresses belonging to 122 distinct entities.
- Imported profile count: 216.
- Generation count: 1; cohort generation count: 1.
- Protocol remains `address-only-v1`; this is not a full historical-data migration.
- Cohort, profiles, import ledger, generation, and identity/authorization records are outside the retention-preflight deletion scope.

The independent restore below reproduced these counts and checked the associated profile, import, channel-version, identity-binding, and head relationships. Counts alone are not presented as the complete migration proof.

## Latest configured release transition: parent-reported evidence

The parent reported production transition `c` as SUCCESS with exit status 0. These transition facts were supplied by the parent in this task, not independently remeasured during this documentation-only step:

- Six-ready timestamp: epoch milliseconds `1791512556513`.
- Release SHA256: `51383e1553a28d0044958a53e6c59379597066dcc43ccb34aab9cd45c72f7ca1`.
- Gateway remains disabled.
- Global current pointer remains unchanged.
- Original SQLite remains untouched.

An earlier independently measured service snapshot, at retention deployment acceptance on 2026-10-09 10:05:23 +08:00, showed all six production services active/running with `NRestarts=0`. Their PIDs and start identities were unchanged across timer enablement, and their starts predated the preflight deployment. That snapshot predates transition `c` and is not substituted for its six-ready evidence.

## Subsequent operations timeline: d refusal and restoration of c

The parent supplied the following operational evidence after the earlier database acceptance. It was not independently remeasured during this documentation-only update.

- Release `d` did not complete activation: native preflight failed `actual_provisioned_contracts`. The old code incorrectly treated the Base MAX pause condition as an invalid provisioned contract.
- The controller entered protected `BLOCKED`; this refusal is not recorded as a successful `d` deployment.
- The parent restored release `c` only after strict matching of all six `c` unit drop-in hashes and all runtime artifact pins.
- Recovery audit directory: `/var/lib/address-radar-maintenance-tools/restore-c-after-d-refusal-1791514514847`.
- Recovery receipt SHA256: `b607b8541f0b97732176cdba335d2dd0ed56b5072cc53d610e1af7c6bffc8860`.
- The reported post-recovery state was six services active/running with `NRestarts=0`. No database rollback was performed; gateway remained disabled.
- The `e` fix and acceptance were not complete at the time of this update. No successful `e` deployment, readiness, or business acceptance is claimed.

The audit directory identifier contains epoch milliseconds `1791514514847`; it is an audit identifier, not a separately verified completion timestamp. This operational refusal/recovery does not rewrite the earlier backup, restore, or isolated roles/ACL receipts, and does not grant business-loop acceptance.

## Native PostgreSQL backup and daily schedule

First successful new backup:

- Run ID: `20261009T014457Z-5ab012cc1aa64f44`.
- Archive: `/var/backups/address-radar/postgres/20261009T014457Z-5ab012cc1aa64f44/business.dump`.
- Archive SHA256: `22bf885753817e6187c897795a5c16bde5f3cd300c0f41ff5784864559fae1e3`.
- Archive size: 1,825,211 bytes.
- Backup receipt SHA256: `1077298d255f7542365b1ff92347f8f12ebe40a7b70ab979c83dcf50f371b488`.
- Last-good marker SHA256: `59458fcfd0a9690893f07d88a4d777171db42915f55a27caaf31d9ae42fc9ce6`.
- Deployment acceptance time: 2026-10-09 09:44:59.074 +08:00.

This is a schema-and-data custom-format dump, not `--schema-only`. The original backup receipt's `restoreVerified=false` was not rewritten; subsequent restore proof is recorded separately below.

The backup uses the existing `address_radar_readonly_operator` over absolute Unix socket `/run/postgresql`, port 5432, with a root-private pgpass. A real successful `pg_dump` established credential/socket matching. An exact local SCRAM HBA rule was inserted before the existing local reject rule; the original HBA was retained, parsing reported zero errors, and reload succeeded without PostgreSQL restart. No public TCP access or extra database privileges were introduced.

- Installed tool: `/var/lib/address-radar-maintenance-tools/postgres-backup/backup-postgres-business-schema.py`, root-owned mode `0400`.
- Tool SHA256: `aa994eecd1e68618ebda24de27921b260a96c394a24009bed4a111773006b589`.
- Job and pgpass: `/etc/address-radar-postgres-backup/job.json` and `/etc/address-radar-postgres-backup/pgpass`, root-owned mode `0600`.
- Backup root: `/var/backups/address-radar/postgres`, root-owned mode `0700`.
- Archive cap: 64 MiB; free-space floor: 3 GiB plus archive/metadata reserve.
- Tool timeout: 45 seconds; systemd start/stop bounds: 50/5 seconds.
- Dedicated timer: daily UTC 02:15, random delay at most 15 minutes, no catch-up.
- First oneshot: `Result=success`, `ExecMainStatus=0`.
- Timer: enabled, active/waiting at acceptance.
- Observed next elapse: 2026-10-09 10:28:59 +08:00. This is the deployment-time observation, not evidence that this later scheduled run completed.

Deployment receipt:

`/var/lib/address-radar-maintenance-tools/postgres-backup-deploy-62b75702e35cb6e2/deployment-receipt.json`

SHA256: `a09c8c5e5339b40024ebe65b9623f6f9ade88b4085f2137f18052c9fb222b692`.

All existing backups are retained. Capacity refusal does not trigger deletion. No old SQLite backup timer was enabled or repurposed. Backup freshness alerting beyond the measured acceptance remains a separate follow-up.

## Independent restore of the new dump

A new unique restore-check database was created in the existing PostgreSQL cluster; no previous restore-check database was overwritten or modified:

`address_radar_restorecheck_20261009_8259cc0d3bfa`

The dump above was restored with `--exit-on-error --single-transaction --no-owner --no-acl`, with a 45-second restore bound and a 64 MiB input cap. Restore exit status was 0. Connection limit was 1, PUBLIC privileges were revoked, and default transaction read-only was enabled before validation. The database is retained, not deleted.

Actual read-only validation results:

| Check | Result |
| --- | --- |
| Schema version | 3 |
| Addresses / distinct entities | 216 / 122 |
| Profiles | 216 |
| Generations / cohort generations | 1 / 1 |
| Missing generation, profile, or import | 0 |
| Extra profile | 0 |
| Missing channel version | 0 |
| Missing or conflicted identity binding | 0 |
| Missing or changed head / orphan heads | 0 / 0 |
| Constraints / unvalidated constraints | 258 / 0 |
| Indexes / invalid indexes | 119 / 0 |
| Transaction read-only / default read-only | on / on |
| Connection limit | 1 |
| PUBLIC CONNECT / any database privilege | false / false |

Acceptance time: 2026-10-09 09:46:49.364 +08:00.

Restore receipt:

`/var/backups/address-radar/postgres/20261009T014457Z-5ab012cc1aa64f44/address_radar_restorecheck_20261009_8259cc0d3bfa-receipt.json`

SHA256: `7248d44a7173c46f1beb4a3ae049b8c0a0c70fa2bc995ee6cb9d8a6513c6b856`.

The receipt binds archive SHA256 `22bf885753817e6187c897795a5c16bde5f3cd300c0f41ff5784864559fae1e3`. This receipt proves this dump's data/schema restoration and the listed checks. Separate fresh-cluster roles/ACL evidence is recorded below; the original data-restore receipt was not rewritten. Default read-only is an operational freeze, not an unoverrideable superuser boundary.

## Isolated roles/ACL reconstruction: native PASS

Acceptance time: 2026-10-09 10:31:59.300632 +08:00. A new independent PostgreSQL cluster restored the same pinned dump and reconstructed the production business authorization catalog from a fresh read-only production measurement. No production provisioning script was executed against production or reused blindly against the isolated target.

- Retained directory: `/var/lib/postgresql/isolated-acl-restore-89071fcaa4d4`.
- Private Unix socket: `/var/lib/postgresql/isolated-acl-restore-89071fcaa4d4/socket`; port `55439`.
- `listen_addresses=''`: no TCP listener.
- Isolated system identifier: `7694490242447654203`; production system identifier: `7693392208475083526`.
- Actual systemd and cgroup memory limit: 536,870,912 bytes; swap limit: 0.
- SQL timeout: 3 seconds; tool deadline: 170 seconds; systemd runtime limit: 180 seconds, with bounded stop protection.
- Successful attempt elapsed time: 3.899 seconds.
- Disk available before/after successful attempt: 5,665,656,832 / 5,588,619,264 bytes, above the 3 GiB floor.
- Cluster stopped in finally; socket absent after stop. Cluster data, previous failed attempts, logs, and receipts were retained, not deleted.

Exact normalized production and isolated catalog comparison passed for 9 business roles, 79 relations, ownership, 1,989 table ACL entries, 305 column ACL entries, one default ACL entry, eight role-setting records, and ten control-function ACL entries. Roles have connection limit 1, no memberships, and no superuser, create-role, create-database, replication, or bypass-RLS privileges. Business relation and schema ownership remains migrator-owned in the reconstructed catalog.

Both catalog files have SHA256:

`ce853c1a6152c4b12e7f09e2aaf9d981ec43325b7538eb4466460c66bdd3e551`

Files are `production-catalog.json` and `isolated-catalog.json` inside the retained directory. Rebuild SQL SHA256: `6ed4ccc8a2aa03b8904aa6380a9130e72097725e5ea47a635a5adab10f15714c`.

Actual native permission tests passed:

- All nine roles connected to the isolated database under their own database identities.
- Each role exercised its granted relation reads: 79 relations for each service, operator, and migrator; 10 for publisher.
- Five runtime writer roles inserted capture identities; publisher inserted a fact; migrator performed owner DDL. All were rolled back.
- Runtime, publisher, and operator identities exercised `pg_control_system()` execution.
- Fifty unauthorized statements were rejected, including protected cohort/profile/ledger mutations, unauthorized fact/capture writes, schema DDL, role creation, and publisher fact updates as applicable.
- Read-only role tests explicitly disabled transaction read-only locally before negative probes, so denial was not merely a read-only transaction error masking missing ACL protection.
- Rollback verification found no test capture, fact, table, or unauthorized role left behind.
- Restored schema 3, 216 addresses, 122 entities, 216 profiles, and one generation were confirmed, with zero invalid constraints or indexes.
- A final read-only production catalog measurement matched the initial measurement; production roles and business data were not modified.

Actual receipt:

`/var/lib/postgresql/isolated-acl-restore-89071fcaa4d4/receipt.json`

SHA256: `1ce1430a0c0c0d28ad4af981ab07f084706e27464dbf3b0c8bab73814440711a`.

Authentication boundary: the cluster used a private Unix socket with isolated trust authentication and the existing postgres OS account. PostgreSQL catalog, data, socket, and system identifier were independent; this was not a separate OS-account isolation test. No production passwords were copied. SCRAM credential/HBA recovery remains unverified. The exercised minimum permission paths and exact catalog match do not constitute exhaustive application-path integration testing or PITR acceptance.

## Maintenance authentication boundary

The existing root-authorized local peer maintenance route remains effective. The pinned reconcile module connects through `sudo -n -u postgres` and the local PostgreSQL Unix socket, without reading a migrator password file. A bounded read-only native probe confirmed `current_user=session_user=postgres`, database `address_radar`, and transaction read-only `on` at epoch milliseconds `1791516604993`. The parent separately reported successful narrowly scoped maintenance using peer authentication plus `SET LOCAL ROLE`; this role-switch result was not independently repeated in that probe.

The final4 historical import job references:

`/var/lib/address-radar-maintenance-tools/address-only-auth-20261008a1378c44/credential.json`

Pinned SHA256: `4d8a84aec2e4a4b25b926f366d20256d90dca8c67c607da66aa9b494b2d022d5`.

This root-owned mode `0600` file matched its recorded pin, but its credential contract expired at epoch milliseconds `1791444684563`; the bounded migrator password-authentication probe was refused with sanitized code `password_authentication_failed`. It is a historical invalid import credential, not a credential used by the running business services or the active peer reconcile route. Reconcile success must not be interpreted as proof that this password remains valid.

No password rotation, role change, ACL expansion, recursive secret-directory search, or production business write was performed for this verification. Future migration work requires a fresh scoped credential or an explicitly approved peer maintenance path; this acceptance does not authorize silent reuse of the expired file. Password/SCRAM authentication recovery has not been fully verified, and the isolated-trust authentication boundary above remains unchanged.

## Daily read-only retention preflight

The independently reviewed configured script was deployed only after the review was explicitly bound to its new SHA256.

- Tool: `/var/lib/address-radar-maintenance-tools/postgres-retention-preflight/postgres-raw-retention-dry-run.py`, root-owned mode `0400`.
- Tool SHA256: `1c98262ca3c3ad33074b5535c0075e830046f5c101708400b22b4b07c48debee`.
- Private job: `/etc/address-radar-postgres-retention-preflight/job.json`, root-owned mode `0600`.
- Job SHA256: `f780e03af0d7625b1da5f8b5a81000c3fbecd64d174c45f73c907c12d80bf71e`.
- Service SHA256: `adbc69ecf578bcd339c50da8180a1df4f7be21251046d3431a13dcd6407da097`.
- Timer SHA256: `920d27035692a090eac0b3f03ef61898984b45141d50cf042d0870a69ce8af73`.
- Dedicated units: `address-radar-postgres-retention-preflight.service` and `.timer`.
- Schedule: daily UTC 01:15, random delay at most 10 minutes, no catch-up; separate from backup UTC 02:15.
- Limits: fixed 500-row candidate window, SQL timeout 3 seconds, total tool limit 30 seconds, systemd stop limit 5 seconds, memory 128 MiB, swap disabled.
- Credentials: existing readonly operator and backup pgpass; no database permission increase.
- Output: sanitized receipt in journal, no raw/semantic payload or candidate identifiers.
- Config and credential rotation must be serialized with execution; no claim is made about resisting concurrent privileged-root mutation.

First native configured run returned exit 0 / `Result=success`:

- Database snapshot: `105826:105826:`.
- As-of epoch milliseconds: `1791511454881`.
- Strict raw cutoff: `received_at < 1790215454881`, corresponding to 15 elapsed days.
- Candidates / protected / would-delete: 0 / 0 / 0.
- Selection and protected-exclusion SHA256: `4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945`.
- `executeSupported=false`, `automaticDeletionEnabled=false`, `productionDataWritten=false`.
- `minimumProofDays=30`, `proofPurge=deferred`.

Timer acceptance: 2026-10-09 10:05:23.172657 +08:00, enabled and active/waiting. Observed next elapse: 2026-10-10 09:21:25 +08:00.

Deployment receipt:

`/var/lib/address-radar-maintenance-tools/postgres-retention-preflight/deployment-receipt.json`

SHA256: `509326e703958aee33844ac9a66abfaeb8a42dd5e6ef3cb0661400152fc1b4b6`.

The script has no delete/purge execution entry point. For nonempty candidate windows, the conservative `consumer_registry_unproven` protection remains in force. Proof is retained, including unfinished proof indefinitely. An exact deletion implementation and independent digest approval are future work, never implicitly activated by this timer.

## Business evidence and remaining gaps

A historical read-only sample at 2026-10-09 08:21 +08:00 showed zero raw captures, normalized results, factual inputs/attestations, purchases, economic trades, trade revisions, token discovery links, and watches. This is a time-bounded observation, not a claim that these counts remain zero after later configured releases. The retention run's zero candidates only establishes no selected raw rows older than its cutoff; it is not a total raw-row count.

The parent subsequently reported Ohm capture count 28, normalization continuing to advance, and purchases/facts still 0. This is parent-supplied progress, not independently remeasured during this documentation update. Source/execution-proof gaps remain under repair. It supersedes neither the timestamps of the earlier zero-count sample nor the independent database receipts.

The latest release readiness and successful database operation do not prove actual radar price acquisition, price coverage, safety validation, qualification, or the complete radar loop. Those require real business facts and producer/consumer evidence. Business-loop acceptance remains NOT PASS. Ohm will supply subsequent business-progress evidence; this document does not invent or pre-accept it. Gateway remains off.

Still not accepted:

- Production SCRAM credential and HBA recovery. Dumps use `--no-owner --no-acl`; the separate measured catalog/rebuild contract remains necessary even though its isolated reconstruction and minimum native permission tests now passed.
- Complete-cluster recovery, WAL archival, point-in-time recovery (PITR), or a tested disaster-recovery RTO.
- Guaranteed daily-backup RPO when a run fails; daily scheduling alone is not continued-success evidence.
- Automatic 15-day raw deletion, proof deletion, or storage reclamation from retention. The deployed timer is preflight only.
- Full price/safety/radar business acceptance or full-system completion.

Database closeout is PASS for this round's measured address-only migration, backup/data restore, isolated roles/ACL reconstruction with minimum native authorization tests, and read-only scheduling scope. This documentation stage is frozen; no additional cluster or tool is created by this update. Preserve the dumps, receipts, HBA original, restore-check databases, and stopped isolated cluster evidence. Subsequent business evidence or separately approved recovery/deletion work must retain these boundaries rather than reinterpret this acceptance as broader authority. Business-loop and full-system acceptance remain NOT PASS.
