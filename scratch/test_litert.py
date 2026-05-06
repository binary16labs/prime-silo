import asyncio
from benny.core.models import call_model

async def test_litert():
    print("--- Phase 5 LiteRT Verification ---")
    # Using the gemma-4-E4B-it model (ID from MODEL_REGISTRY)
    model_id = "litert/gemma-4-E4B-it.litertlm"
    messages = [{"role": "user", "content": "Hi! Answer with one word: 'READY'."}]
    
    print(f"Calling LiteRT model: {model_id}")
    try:
        # LiteRT takes a few seconds to load the first time
        response = await call_model(model_id, messages)
        print(f"\nResponse: {response}")
        print("\n--- SUCCESS ---")
    except Exception as e:
        print(f"\nFAILED: {e}")

if __name__ == "__main__":
    asyncio.run(test_litert())
