import httpx
import json

async def get_models():
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            response = await client.get("http://127.0.0.1:13305/api/v1/models")
            if response.status_code == 200:
                data = response.json()
                print(json.dumps(data, indent=2))
            else:
                print(f"Error: {response.status_code}")
    except Exception as e:
        print(f"Failed to connect: {e}")

if __name__ == "__main__":
    import asyncio
    asyncio.run(get_models())
