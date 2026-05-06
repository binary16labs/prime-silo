import asyncio
from benny.synthesis.correlation import run_full_correlation_suite

async def verify_fix():
    print("Verifying Correlation Fix for 'code2'...")
    results = await run_full_correlation_suite("code2", threshold=0.70)
    print(f"Results: {results}")

if __name__ == "__main__":
    asyncio.run(verify_fix())
