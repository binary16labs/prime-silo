import asyncio
from litellm import completion
import os

async def test_litellm():
    print("--- LiteLLM (Old Path) Diagnostic ---")
    model_id = "openai/qwen3-tk-4b-FLM"
    api_base = "http://127.0.0.1:13305/api/v1"
    
    print(f"Calling LiteLLM with base: {api_base}")
    try:
        response = completion(
            model=model_id,
            messages=[{"role": "user", "content": "hi"}],
            api_base=api_base,
            api_key="not-needed",
            timeout=10
        )
        print(f"SUCCESS! Response: {response.choices[0].message.content}")
    except Exception as e:
        print(f"FAILED: {e}")

if __name__ == "__main__":
    asyncio.run(test_litellm())
