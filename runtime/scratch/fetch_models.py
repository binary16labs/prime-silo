import httpx
import asyncio
import json

async def main():
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get("http://localhost:13305/api/v1/models")
            if resp.status_code == 200:
                models = resp.json()
                print(json.dumps(models, indent=2))
            else:
                print(f"Error: {resp.status_code}")
    except Exception as e:
        print(f"Failed: {e}")

if __name__ == "__main__":
    asyncio.run(main())
