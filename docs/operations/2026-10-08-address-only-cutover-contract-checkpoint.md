# Address-only cutover contract checkpoint

## Verified implementation fixes

The read-only production observation contract now covers the measured process and
service counts, queries login session properties individually, and distinguishes
unobserved inactive managers from unresolved observed managers. Full regression
passed: 337 files / 2,725 tests, with 25 files / 107 tests skipped. Discovery-specific
Python tests passed: 42. Automation and PostgreSQL entrypoint type checks passed.

Commit `7c0192d` contains the discovery changes. The reviewed helper was installed
in a private, hash-pinned production evidence directory; business services were
not switched. All six business services remained active with zero restarts in the
latest native check.

## Additional contract drift

The bootstrap coordinator source pin was stale. The measured source digest is
`1544baca2bbe6f78a19e62d74d9c28ce3bdbd0bc6795b3276f3765ee2394a07b`.
The closure source digest remains
`f007a84bd69d0426620387dec0d65b9c252ca6a951ed7581b5aecd3968bbfb2a`.
The bootstrap pin now references the tested coordinator bytes, and a source-byte
regression test prevents silent drift. Updating this pin does not install keys,
approve a scope inventory, sign observations or authorize production writes.

## Distinguish discovery from the real fence

The read-only discovery per-process FD limit of 256 is below Chrome's measured
approximately 685 descriptors. This prevents that discovery pass from claiming
complete kernel coverage, but the real native writer-boundary implementation has
separate limits: 4,096 processes, 8,192 FD names per task, and 100,000 total FD
observations. Do not stop Chrome or relax the actual fence to make discovery green.

The actual fence also requires a root-owned source namespace, no writable source
handles or mappings, closed admission records, a stable process/task census and
protected, scoped collector execution. These conditions have not yet been installed
or proven on this production source.

## Production operations still required

Neither `/etc/address-radar/sqlite-writer-admission` nor
`/var/lib/address-radar-migration-authority` existed at the latest native check.
Production collector entry composition and these controls must be installed before
the final maintenance interval. The existing private compatibility/rehearsal lane
does not authorize the production target.

After those prerequisites, the remaining atomic sequence is: close source writers,
capture the final address-only snapshot, generate a fresh reviewed import plan,
record import and first-write marker in one PostgreSQL transaction, independently
verify parity, verify service startup proof, switch the six services, and accept a
fresh real address-channel event with gateway delivery disabled.

Migration is not complete. The production address cohort remains unimported; the
old services and retained SQLite/backups remain the live fallback before first write.
