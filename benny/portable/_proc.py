"""Cross-platform process primitives (stdlib only).

The portable runner stays dependency-free: `psutil` is nice but pulls a C
extension, and every major OS the PBR matrix supports can answer
*is-this-pid-alive?* and *kill-this-pid* from stdlib alone.

Windows uses kernel32 via ctypes; POSIX uses ``os.kill`` with signal 0.
"""
from __future__ import annotations

import os
import signal
import sys
import time

_IS_WINDOWS = sys.platform == "win32"

_STILL_ACTIVE = 259  # Windows GetExitCodeProcess sentinel
_PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
_PROCESS_TERMINATE = 0x0001


def is_alive(pid: int) -> bool:
    """Return True iff the given OS PID is a currently running process."""
    if pid <= 0:
        return False
    if _IS_WINDOWS:
        import ctypes

        k32 = ctypes.windll.kernel32
        handle = k32.OpenProcess(_PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
        if not handle:
            return False
        try:
            exit_code = ctypes.c_ulong(0)
            ok = k32.GetExitCodeProcess(handle, ctypes.byref(exit_code))
            if not ok:
                return False
            return exit_code.value == _STILL_ACTIVE
        finally:
            k32.CloseHandle(handle)

    try:
        os.kill(pid, 0)
    except (ProcessLookupError, PermissionError):
        # PermissionError means the pid exists but isn't ours — still alive.
        if isinstance(sys.exc_info()[1], PermissionError):
            return True
        return False
    except OSError:
        return False
    return True


def terminate(pid: int, *, grace_seconds: float = 10.0) -> bool:
    """Terminate a process by PID. Returns True if the process is gone afterwards.

    Sends a graceful signal first, waits up to ``grace_seconds`` for exit,
    then escalates to a hard kill.
    """
    if not is_alive(pid):
        return True

    if _IS_WINDOWS:
        import subprocess
        # /T kills the entire process tree so child processes (e.g. node/vite
        # spawned by benny-ui.cmd) don't become orphans after the wrapper dies.
        subprocess.run(
            ["taskkill", "/F", "/T", "/PID", str(pid)],
            capture_output=True,
        )
    else:
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            return True
        except OSError:
            pass

    deadline = time.monotonic() + grace_seconds
    while time.monotonic() < deadline:
        if not is_alive(pid):
            return True
        time.sleep(0.1)

    # Escalate on POSIX; on Windows TerminateProcess is already hard.
    if not _IS_WINDOWS:
        try:
            os.kill(pid, signal.SIGKILL)
        except (ProcessLookupError, OSError):
            return not is_alive(pid)
        time.sleep(0.2)

    return not is_alive(pid)
