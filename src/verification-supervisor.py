"""Fixed Linux subprocess supervisor. No checkout imports or dependency scripts."""
import ctypes
import json
import os
import signal
import sys
import time


def main():
    # A kernel child-subreaper adopts orphaned descendants even after setsid(),
    # double-fork or unref. Process-group enumeration cannot provide this property.
    if sys.platform != 'linux' or sys.version_info[:2] not in ((3, 11), (3, 12)):
        return 125
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(36, 1, 0, 0, 0) != 0:  # PR_SET_CHILD_SUBREAPER
        return 125
    children_path = '/proc/self/task/%d/children' % os.getpid()
    with open(children_path, encoding='ascii') as children:
        children.read()
    if sys.argv[1:] == ['--probe']:
        print('nibfin-subreaper-v1')
        return 0
    command = json.loads(sys.argv[1])
    stopped = False

    def stop(_number, _frame):
        nonlocal stopped
        stopped = True

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    # Queue parent cancellation until the fixed handlers can reap every child.
    # SIGTERM during Python bootstrap would otherwise kill the proof owner.
    os.write(3, b'{"ready":true}\n')
    error_read, error_write = os.pipe()
    pid = os.fork()
    if pid == 0:
        try:
            os.close(error_read)
            os.close(3)  # Only the supervisor can issue the reconciliation proof.
            signal.signal(signal.SIGTERM, signal.SIG_DFL)
            signal.signal(signal.SIGINT, signal.SIG_DFL)
            os.setsid()
            os.execve(
                command['file'], [command['file'], *command['args']],
                dict(os.environ),
            )
        except BaseException:
            os.write(error_write, b'1')
            os._exit(127)
    os.close(error_write)
    remaining = (command['deadlineAt'] - time.time() * 1000) / 1000
    deadline = time.monotonic() + max(0, remaining)
    status = None
    cleanup_deadline = None
    timed_out = False
    while True:
        # Reaping to ECHILD is the kernel proof that this owner has no children.
        try:
            while True:
                child, value = os.waitpid(-1, os.WNOHANG)
                if child == 0:
                    break
                if child == pid:
                    status = value
        except ChildProcessError:
            if status is None:
                return 125
            proof = {
                'reconciled': True,
                'exitCode': os.waitstatus_to_exitcode(status),
                'cancelled': stopped,
                'timeout': timed_out,
                'spawnFailed': bool(os.read(error_read, 1)),
            }
            os.close(error_read)
            os.write(3, (json.dumps(proof) + '\n').encode())
            return 0
        if time.monotonic() >= deadline:
            timed_out = True
        if status is not None or stopped or timed_out:
            if cleanup_deadline is None:
                cleanup_deadline = time.monotonic() + 2
            # Kill current direct children. Killing a parent causes its children
            # to be adopted here; repeat until waitpid reports ECHILD.
            with open(children_path, encoding='ascii') as children:
                owned = [int(value) for value in children.read().split()]
            for child in owned:
                try:
                    os.kill(child, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            if time.monotonic() >= cleanup_deadline:
                return 125  # No proof: caller must latch the lane unresolved.
        time.sleep(0.002)


try:
    sys.exit(main())
except Exception:
    # Never print command/provider data or claim reconciliation after an error.
    sys.exit(125)
