"""Source-replacement sequencing primitives; native executable binding is not ready.

This module deliberately refuses command-line execution. Passing its unit tests
is not evidence that a production controller, import, or probe was connected.
"""
import fcntl
import os
from pathlib import Path


def _assert_retained_lock(owner):
    """An independent open must be excluded; dup alone cannot detect LOCK_UN."""
    owner.owned()
    held = os.fstat(owner.fd)
    actual = os.stat(owner.n.lock_path, follow_symlinks=False)
    if (actual.st_dev, actual.st_ino) != (held.st_dev, held.st_ino):
        raise ValueError('controller_lock_identity')
    probe = os.open(owner.n.lock_path, os.O_RDWR | os.O_NOFOLLOW)
    try:
        opened = os.fstat(probe)
        if (opened.st_dev, opened.st_ino) != (held.st_dev, held.st_ino):
            raise ValueError('controller_lock_identity')
        try:
            fcntl.flock(probe, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        # This descriptor acquired a new lock, not the owner's missing lock.
        fcntl.flock(probe, fcntl.LOCK_UN)
        raise ValueError('controller_lock_not_retained')
    finally:
        os.close(probe)


def delegated_fence_type(module, owner):
    """Borrow the retained open-file description, never acquire a second flock."""
    class DelegatedFence(module.NativeSourceFence):
        def _lock_control(self, deadline):
            _assert_retained_lock(owner)
            expected = Path(module.CONTROL) / 'controller.lock'
            if expected != Path(owner.n.lock_path):
                raise ValueError('controller_lock_path')
            self.deadline = deadline
            self.lock = os.dup(owner.fd)
            os.set_inheritable(self.lock, False)
            try:
                _assert_retained_lock(owner)
                self.journal = module.Journal()
            except BaseException:
                os.close(self.lock)
                self.lock = None
                raise

        def close(self):
            # Never call a legacy close that may LOCK_UN the shared description.
            if self.lock is not None:
                os.close(self.lock)
                self.lock = None
            _assert_retained_lock(owner)
    return DelegatedFence


def before_unguard(context, adapter):
    """Require the actual adapter and published bindings before the first start."""
    _assert_retained_lock(context.owner)
    if adapter is not context.adapter:
        raise ValueError('adapter_identity')
    if context.handed_off:
        return
    context.publication(adapter)
    _assert_retained_lock(context.owner)
    context.handoff()
    _assert_retained_lock(context.owner)
    context.handed_off = True


class _UnguardGate:
    """One-attempt capability to be installed at every native unguard/start edge.

    Installation is an adapter contract, not proof that an arbitrary deploy
    callable obeys it. Native controller wiring remains a separate release gate.
    """
    def __init__(self, context):
        self.context = context
        self.active = False

    def __call__(self, adapter):
        if not self.active:
            raise ValueError('unguard_gate_inactive')
        before_unguard(self.context, adapter)


def run_transition(context, preflight, stop, deploy, reblock):
    """Sequence one attempt; no uncertain phase retries or implicit activation.

    bind_unguard_gate must return this exact gate after installing it in the
    actual adapter, before any work. Binding and guard verification are required
    ports, not an implementation of the production controller.
    """
    gate = _UnguardGate(context)
    try:
        _assert_retained_lock(context.owner)
        if context.handed_off:
            raise ValueError('transition_already_handed_off')
        if context.bind_unguard_gate(gate) is not gate:
            raise ValueError('unguard_gate_not_bound')
        context.rotate()
        _assert_retained_lock(context.owner)
        context.bind_guards()
        context.verify_guards()
        _assert_retained_lock(context.owner)
        stop()
        context.drain()
        for phase in ('import', 'probe'):
            _assert_retained_lock(context.owner)
            context.phase(phase)
        preflight()
        _assert_retained_lock(context.owner)
        gate.active = True
        result = deploy()
        if not context.handed_off:
            raise ValueError('handoff_not_completed')
        _assert_retained_lock(context.owner)
        return result
    except BaseException:
        gate.active = False
        try:
            reblock()
        except BaseException:
            # Preserve the primary failure without treating uncertain recovery as success.
            context.recovery_status = 'UNVERIFIED_HOLD'
        else:
            context.recovery_status = 'VERIFIED_BLOCKED'
        finally:
            context.hold_persisted = False
            try:
                context.preserve()
            except BaseException:
                # The original failure remains authoritative even if storage fails.
                context.hold_persisted = False
            else:
                context.hold_persisted = True
        raise
    finally:
        gate.active = False


def main():
    raise SystemExit('native_stage_binding_not_implemented')


if __name__ == '__main__':
    main()
