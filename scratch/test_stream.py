import asyncio
from benny.core.local_executor import LemonadeExecutor

async def test_streaming():
    print("--- Lemonade Streaming Test ---")
    executor = LemonadeExecutor(model="qwen3-tk-4b-FLM")
    
    print("Requesting stream...")
    try:
        count = 0
        async for chunk in executor.stream("Tell me a story about a cat."):
            print(chunk, end="", flush=True)
            count += 1
        print(f"\n--- SUCCESS (Received {count} chunks) ---")
    except Exception as e:
        print(f"\nFAILED: {e}")

if __name__ == "__main__":
    asyncio.run(test_streaming())
