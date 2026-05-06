import asyncio
import os
from benny.core.models import call_model, is_local_model
from benny.core.local_executor import resolve_executor

async def verify_lemonade():
    model_id = "lemonade/user.gemma-4-E4B-it-GGUF"
    messages = [{"role": "user", "content": "Tell me a very short joke."}]
    
    print(f"--- Phase 5 Verification ---")
    print(f"Target Model: {model_id}")
    print(f"Is Local Model: {is_local_model(model_id)}")
    
    executor = resolve_executor(model_id)
    print(f"Resolved Executor: {type(executor).__name__}")
    
    # Override for multi-host testing
    from benny.core.local_executor import BaseOpenAICompatibleExecutor
    executor = BaseOpenAICompatibleExecutor(
        model_id="qwen3-tk-4b-FLM",
        provider_name="lemonade-remote",
        base_url="http://192.168.68.134:13305/api/v1"
    )
    print(f"Testing against REMOTE: {executor.base_url}")

    print(f"Calling model (direct bypass)...")
    try:
        response = await call_model(model_id, messages, run_id="verify-run-1")
        print(f"\nResponse: {response}")
        print("\n--- SUCCESS ---")
    except Exception as e:
        print(f"\nFAILED with error: {e}")

if __name__ == "__main__":
    asyncio.run(verify_lemonade())
