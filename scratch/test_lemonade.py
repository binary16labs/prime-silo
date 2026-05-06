import asyncio
import os
import sys

from benny.core.local_executor import resolve_executor

async def main():
    print("Testing LemonadeExecutor...")
    exec_obj = resolve_executor("lemonade/qwen3.5-9b-FLM")
    if not exec_obj:
        print("Failed to resolve executor")
        return

    # Use a small prompt to test
    try:
        res = await exec_obj.generate("Hello, are you working?", max_tokens=50)
        print("SUCCESS:", res)
    except Exception as e:
        print("ERROR:", type(e).__name__, str(e))

if __name__ == "__main__":
    asyncio.run(main())
