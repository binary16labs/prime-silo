import asyncio
from benny.core.models import call_model

async def test_404():
    print("--- Lemonade 404 Test ---")
    model_id = "lemonade/invalid-model-name"
    messages = [{"role": "user", "content": "hi"}]
    
    try:
        response = await call_model(model_id, messages)
        print(f"Response: {response}")
    except Exception as e:
        print(f"EXPECTED ERROR: {e}")

if __name__ == "__main__":
    asyncio.run(test_404())
