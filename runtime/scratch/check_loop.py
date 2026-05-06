import asyncio
import sys
import os

print(f"Platform: {sys.platform}")
print(f"Python: {sys.version}")

try:
    loop = asyncio.get_event_loop()
    print(f"Default Loop: {type(loop).__name__}")
except Exception as e:
    print(f"Error getting loop: {e}")

if sys.platform == "win32":
    try:
        from asyncio import WindowsProactorEventLoopPolicy, WindowsSelectorEventLoopPolicy
        policy = asyncio.get_event_loop_policy()
        print(f"Current Policy: {type(policy).__name__}")
    except Exception as e:
        print(f"Error getting policy: {e}")

# Check FD limit if possible (though on Windows it's usually 512 for select, but 64 for some specific things in asyncio)
# Actually, the 64 limit is for WaitForMultipleObjects in the Selector loop on Windows.
