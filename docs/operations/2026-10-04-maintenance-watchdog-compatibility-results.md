# Maintenance watchdog compatibility results

## Scope and decision

Resource-only maintenance was authorized. Production database migration, release switching, and gateway delivery were not authorized by this window. Full preservation acceptance remains NO-GO.

## Completed repairs

- Normalize an omitted empty `TimersCalendar` only for the exact nonce-bound, loaded, active, waiting, transient watchdog timer with all other requested fields and its exact trigger present.
- Verify disarm using complete `Id`, `LoadState`, `ActiveState`, and `SubState`. An exact nonce-bound loaded or not-found unit that is inactive/dead is already disarmed. Other omissions, identity mismatches, and failed commands remain errors.
- Preserve pre-arm checks, immutable baseline binding, production configuration guards, and protected FOMO services.

Frozen helper SHA256: `1940d7d0b7ba7925278701eb5ef4d2968771c3785d1dbcc3a584c7819e9d41dd`.

Frozen test SHA256: `a3ddff841305b57fb525701f626e031d4705d93afa73fdabfb496920913bde3d`.

All 59 maintenance tests passed in the parent run. The implementation agent reported failing regressions before the fixes. A separate reviewer inspected the changed methods and tests and reported no P0/P1 in this narrow scope.

## Actual no-op acceptance

- Independent watchdog service: nonce `ac21b19cf2afc042`, successful exit and `phase=restored`.
- Manual cancellation of an armed, never-run watchdog: nonce `e2201a9824674ea1`, `status=restored` and `phase=restored`.
- Neither no-op paused business services. Their original PIDs and timer states were retained.

## Actual maintenance attempt

Nonce: `25401dced789a860`.

Baseline SHA256: `1b02c9425a324f4141a83e1bcec5dd830eea24a4176f2138bd3482e606166b4a`.

The independent 55-minute watchdog was armed. Pause did not complete successfully and reported:

```text
pause_failed:Refused;restore_errors=address-radar-automation.service:gateway_not_disabled,address-radar-console.service:gateway_not_disabled
```

The generic `Refused` wrapper does not identify the original pause failure. The two gateway errors during the first restoration do not prove gateway delivery was enabled; startup timing or process selection still requires investigation.

An immediate second manual restoration succeeded. Its status reported `phase=restored`; all six main services were active/running and all five application timers were active/waiting. Explicit process-environment checks then confirmed `ADDRESS_RADAR_GATEWAY_DELIVERY_ENABLED=false` for all six main services. FOMO collector, login, and noVNC retained their original PIDs. The originally failed protocol-audit auxiliary service remained failed and was not reset.

Both maintenance transient units were subsequently confirmed not-found/inactive/dead. Current release remained `/opt/address-radar/releases/4b48fc2-forward-token-code`.

## Remaining acceptance

No private full preservation runner was started during this attempt. No production database or release switch occurred.

Before another window, diagnose the exact original pause refusal and restart-time gateway verification, add focused regression coverage, and repeat real recovery acceptance. Do not weaken gateway checks or classify partial pause/restoration as successful migration. Full immutable-source PostgreSQL import/resume/parity and the separately gated final migration and rollback proof remain outstanding.
