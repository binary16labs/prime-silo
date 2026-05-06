import sys
import asyncio

if sys.platform == "win32":
    try:
        # Use ProactorEventLoop on Windows to handle more than 64 sockets/files
        # and avoid the "too many file descriptors in select()" error.
        asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())
    except Exception:
        pass

__version__ = "1.0.0"
