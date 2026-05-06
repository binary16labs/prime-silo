import httpx
import asyncio
import json

async def test():
    client = httpx.AsyncClient(timeout=300.0)
    
    print("Fetching models...")
    try:
        res = await client.get('http://localhost:13305/api/v1/models')
        print(f"Models ({res.status_code}):", res.text)
    except Exception as e:
        print("Models fetch failed:", e)

    print("\nTesting chat completion with Gemma...")
    try:
        res = await client.post('http://localhost:13305/api/v1/chat/completions', json={
            'model': 'Gemma-3-4b-it-FLM',
            'messages': [{'role': 'user', 'content': 'Hello!'}]
        })
        print(f"Status ({res.status_code}):", res.text)
    except Exception as e:
        print("Chat API failed:", e)

asyncio.run(test())
