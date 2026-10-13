# Readonly v2 scope inventory acceptance

No host operations, native signatures, authority keys, service/timer mutations or
scope approval performed. V1 parsing/native command contract is retained.
Private snapshot code gate closure does not approve this new discovery v2 phase.

## New measured surfaces

- Global observed user-manager UIDs are derived from complete system unit/unit-file
  and session listings. Every observed UID must map to an explicitly approved user
  AND an actually queried active manager with loaded identity and nonzero MainPID.
  All user listings must parse within the same original budgets. Unknown UIDs,
  account/query errors and partial listings remain partial. This is observed manager
  inventory coverage, not prevention of future managers or operator writers.
- Kernel threads (measured PF_KTHREAD) and zombies can lack exe only with pinned
  proc identity/start ticks/class before and after. FD and maps are actually scanned;
  only zero descriptors AND zero maps admit MEASURED_EMPTY disposition. No blanket
  kernel/zombie skip. Live userspace missing exe and dead/reused/disappearing process
  identities remain unresolved. PID sets are enumerated before/after; any change
  keeps coverage partial. This discovery pass does not replace the stricter managed
  kernel boundary's per-thread/FD flags/permission/admission drain proofs.
- Cron metadata includes the entire /var/spool/cron/crontabs directory, not just the
  approved user subset. Bounded nofollow read/metadata hashes do not disclose job
  contents. Every file remains unreviewed; enumeration is not admission control.

Unchanged limits: original operation30s, bounded subprocesses/bytes/listing512.
Kernel limits remain explicit (128 processes,256FD each,4096totalFD,etc). A native
bound refusal is a real blocker; do not silently increase or truncate. Global
session, bridge/deploy/external-input admission, pending jobs, operator approvals
and cron/control classifications still require genuine native evidence/controls.

## Exact next native lane (parent only, after release)

A local unapproved plan was generated from the existing captured real report:
/private/tmp/address-radar-scope-v2-native-plan-20261006.json.
It contains old source/runtime reference pins, not fresh approval. Its approvedUsers
is EMPTY; ubuntu is merely a measured session-owner candidate. Parent must first
freshly measure permitted metadata and explicitly review the user-account scope.
The known report/43 review candidates are NOT approved scopes.

Install the reviewed current helper in an exclusive root0700 hash namespace with
entry0600. Publish canonical approved policy through the fixed protected adapter.
Expected entry SHA must be actual bytes of the newly reviewed helper, not the old
installed v1 entry or a document/library hash. Then execute only the readonly lane:

```sh
"$PINNED_PYTHON" -I -B "$PINNED_DISCOVERY_V2_ENTRY" discover \
  --policy "$PROTECTED_APPROVED_V2_POLICY" \
  --policy-sha256 "$APPROVED_V2_POLICY_SHA256" \
  --expected-entry-sha256 "$REVIEWED_V2_ENTRY_SHA256"
```

The helper deliberately returns non-readiness/non-fence status; capture sanitized
JSON under the separate approved root evidence namespace. Preserve originals.
Review actual listingFailures/dispositions/coverage/sourceHolders, not generic
SOURCE error or a fabricated inventoryComplete flag. Check FOMO three identities
against original capture and require actual fresh source/runtime pins unchanged.
If bounds fail, report exact bound and actual counts; no blind retry/kill.

Next reviewed inventory must reference the real metadata evidence hashes and exact
classification/admission controls for all seven scope kinds. Use the authority
profile planner only after each unknown is resolved/denied by measured controls.
No signature/key profile can turn these unsigned measurements into a native fence.
New local operator bootstrap remains explicitly distinct from historical/external
trust; phase contract-pin changes remain pending their separate review gate.
