# Production target preparation: preserved cluster stage

## Observed outcome

The reviewed preparation script passed native read-only preflight. One authorized
apply attempt subsequently returned `stage_failed_preserved`. No retry was made.

- Script SHA-256: `d70ab3c0ef4d89b12f40296418cb4b7a83bad561c7ec544d5123f1bf2d308f96`.
- Canonical plan SHA-256: `5d468ae9c2acd2464814deeee28bf2d0ca9f91b1721c729cae91d82996311385`.
- Journal retains `pending: cluster` under the protected provisioning directory.
- PostgreSQL 16 `radarproduction`, port 5432, exists and is DOWN.
- Existing `radaracceptance`, port 5433, remains online in the observed inventory.
- Target data directory: UID 110, GID 114, mode 0700.
- Target configuration directory: UID 110, GID 114, mode 0755.

## Diagnosed mismatch

The post-create configuration protection code requires root-owned configuration
ancestors. Native read-only inspection found `/etc/postgresql` and
`/etc/postgresql/16` owned by postgres (UID 110, GID 114), mode 0755; `/etc`
is root-owned, mode 0755. This default layout conflicts with the script's
ancestor assumption before target configuration mode normalization.

A subsequent read-only resource guard passed. Native observation refused with
`target_ownership_changed`; the configuration directory remains 0755 rather
than the planned 0700. These observations do not acknowledge the cluster stage.

## Recovery constraints

Do not delete the pending journal, automatically adopt the target, recreate the
cluster, or blindly rerun apply. First implement and review explicit ancestor
identity checks and a provenance-backed reconciliation procedure. Do not change
shared configuration parent ownership to satisfy an incorrect assumption.

The attempt did not reach business role creation, business database creation,
credential activation, data import, or backend cutover. Production migration
readiness and full-capacity proof remain false.

## Other preparation evidence

The scoped receipt sandbox mount compatibility fix passed 83 local mock tests
and independent changed-code review. Real systemd sandbox execution and the
receipt writer/reader chain still require acceptance; mock evidence is not a
substitute for those gates.

## Native recovery and target preparation completed

The original pending cluster has now been reconciled, without recreation or
deletion. Recovery used separately reviewed operator authority and explicitly
identified post-hoc controller transcripts; no historical durable proof was
claimed. Native read-only comparison matched all 999 inventory entries, the
system identifier and the raw `global/pg_control` hash before recovery.

- Final preparation script SHA-256:
  `43978c786e262cf4abb037b9be7d2ea556b31c0532ad10df8bfbdfecadbc9c7f`.
- Recovery/current canonical plan SHA-256:
  `b8e9bd6ec46723e0eeb45915c12c86d61168d24569c934bce70039bafe2e0b46`.
- Frozen operator review SHA-256:
  `7b3a8395546eaf5a2cb71c3af04071fb3e8794fe0a6e45caab725b7d9caded5f`.
- Recovery evidence SHA-256:
  `567928a2db93a6b79b7cb5f47ba04ccd2c1e2309e9c57ee796b3e9a28e617f01`.
- Target system identifier: `7693392208475083526`.
- Local preparation regression suite: 65 tests passed.

The native recovery command returned `cluster_reconciled`. Subsequent normal
apply returned `prepared`: the independent target is configured and started,
the seven business roles remain NOLOGIN, credentials are not installed, and
the business schema remains deferred. No business data was imported, no backend
was switched, no trust was issued, and delivery remains disabled. Both
production migration readiness and full-capacity proof remain false.

### Resource-only maintenance attempt

Window `14de68416d9350bb` was captured and armed with an independent restore
watchdog. Pause refused because service/child closure was not proven in time;
its initial rollback reported a scanner restore timeout. The controller's
finally path subsequently restored the baseline successfully and status
reported all six business services active. FOMO collector/login/noVNC retained
their original PIDs. No recovery command ran inside that failed window.

Later fresh resource guards and exact review binding passed without another
pause, allowing the limited recovery and target preparation above. The scanner
unit reports 90-second start/stop timeouts. A separately tested maintenance
deadline compatibility fix still requires review, deployment and native
acceptance before use in a new window.

### Remaining migration work

Target preparation does not establish schema installation, authenticated data
import, full preservation parity, a final source writer fence/snapshot,
production connection capacity, PostgreSQL-compatible rollback or successful
business cutover. These remain separate gates.
