import asyncio
import os
from benny.core.models import call_model

async def test():
    try:
        # Use litert which should trigger the redirection to lemonade
        response = await call_model(
            model="litert/test", 
            messages=[{"role": "user", "content": "Hello, respond with 'Pong'"}],
            timeout=10
        )
        print(f"Response: {response}")
    except Exception as e:
        print(f"Error: {e}")

if __name__ == "__main__":
    asyncio.run(test())
