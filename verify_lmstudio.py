import httpx
import asyncio

async def test_lmstudio():
    urls = [
        "http://localhost:1234/v1/models",
        "http://127.0.0.1:1234/v1/models",
        "http://localhost:1234/models",
        "http://127.0.0.1:1234/models"
    ]
    
    print("Testing LM Studio connectivity...")
    for url in urls:
        try:
            print(f"Checking {url}...", end=" ")
            async with httpx.AsyncClient(timeout=2.0) as client:
                resp = await client.get(url)
                print(f"STATUS: {resp.status_code}")
                if resp.status_code == 200:
                    print(f"SUCCESS! Models: {len(resp.json().get('data', []))}")
                    return
        except Exception as e:
            print(f"FAILED: {str(e)}")

if __name__ == "__main__":
    asyncio.run(test_lmstudio())
