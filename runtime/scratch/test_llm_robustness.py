import asyncio
import sys
import os
from unittest.mock import MagicMock, patch

# Ensure we can import from benny
sys.path.append(os.path.abspath('.'))

async def test_robustness():
    print("Starting LLM Robustness Test...")
    
    from benny.core.models import call_model
    
    # Mock Response types
    class MockMessage:
        def __init__(self, content):
            self.content = content

    class MockChoice:
        def __init__(self, content):
            self.message = MockMessage(content)

    class MockResponse:
        def __init__(self, content):
            self.choices = [MockChoice(content)]
            self.usage = {"prompt_tokens": 10, "completion_tokens": 20}
        def get(self, key, default=None):
            if key == "usage": return self.usage
            return default

    # =========================================================================
    # TEST 1: Standard Object Response (Success)
    # =========================================================================
    print("\n[TEST 1] Testing Object Response...")
    with patch('benny.core.models._run_completion') as mock_comp:
        mock_comp.return_value = MockResponse("Hello from Object!")
        try:
            content = await call_model(model="openai/gpt-4", messages=[{"role": "user", "content": "hi"}])
            print(f"SUCCESS: {content}")
        except Exception as e:
            print(f"FAILED: {e}")

    # =========================================================================
    # TEST 2: Dictionary Response (The failure case)
    # =========================================================================
    print("\n[TEST 2] Testing Dictionary Response (Fix verification)...")
    with patch('benny.core.models._run_completion') as mock_comp:
        mock_comp.return_value = {
            "choices": [{
                "message": {"content": "Hello from Dict!"}
            }],
            "usage": {"prompt_tokens": 5, "completion_tokens": 5}
        }
        try:
            content = await call_model(model="openai/gpt-4", messages=[{"role": "user", "content": "hi"}])
            print(f"SUCCESS: {content}")
        except Exception as e:
            print(f"FAILED: {e}")

    # =========================================================================
    # TEST 3: Broken Response (Missing choices)
    # =========================================================================
    print("\n[TEST 3] Testing Broken Response (Graceful failure)...")
    with patch('benny.core.models._run_completion') as mock_comp:
        mock_comp.return_value = {"error": "Unauthorized"}
        try:
            await call_model(model="openai/gpt-4", messages=[{"role": "user", "content": "hi"}])
            print("FAILED: Should have raised KeyError")
        except KeyError as e:
            print(f"SUCCESS: Caught expected KeyError: {e}")
        except Exception as e:
            print(f"FAILED: Caught unexpected exception: {type(e).__name__}: {e}")

if __name__ == "__main__":
    asyncio.run(test_robustness())
