# Opportunity Discovery: Checkpoint 3

Status: implementation prepared; tests, commit and deployment not performed.

## Admission and signal eligibility

An admitted observing trader with a verified identity no longer needs an
ability-score snapshot before its signal profile can enable monitoring.
Explicit monitoring opt-out remains authoritative. FOMO monitoring requires
an explicit confirmed account link rather than a wallet-only synthetic identity.
On-chain monitoring requires a confirmed wallet. Existing candidate thresholds,
signal windows and delivery configuration are unchanged.

## Historical capability

The opportunity ability worker records historical recurrence tags only when
the approved new evaluator confirms recurrence. These tags are retained when
recent purchases age out. The library distinguishes historical capability
from current 30-day recurrence and selects the newer result between runtime
and automation evaluations. Legacy stable stages do not create these tags.

## Backfill attribution and dispatch

Wallet-history attribution accepts the explicit trader ID in an initial
backfill payload as well as the legacy trader subject key. Wallet-shaped job
subjects no longer hide their analysis positions. Missing entry prices remain
missing data; wallet valuations are not converted into opportunity evidence.

Daily ability scanning uses the actual available batch capacity when deciding
whether the scan is exhausted. Backpressure can no longer end the daily scan
early simply because a batch contains fewer than 100 traders.

## Regression tests prepared

- An observing resolved wallet enables its on-chain signal profile without
  ability snapshots, while wallet-only identity does not enable FOMO.
- Explicit opt-out disables both channels during profile synchronization.
- Historical recurrence persists after the recent cohort expires.
- A capacity-reduced dispatch batch retains its continuation cursor.

These tests have not been executed. No production data or configuration was
modified. Complete range recovery, canonical wallet visibility and collector
ownership still require subsequent implementation and acceptance.
