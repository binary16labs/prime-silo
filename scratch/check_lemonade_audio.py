import httpx
import asyncio
import json

async def main():
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            # Check transcribe endpoint
            print("Checking transcription capability...")
            # We don't have an audio file yet, but we can check if the route exists or returns a 405/422 (meaning it exists but valid params missing) vs 404
            resp = await client.post("http://localhost:13305/api/v1/audio/transcriptions")
            print(f"Transcription Route: {resp.status_code}")
            
            print("\nChecking speech capability...")
            resp = await client.post("http://localhost:13305/api/v1/audio/speech")
            print(f"Speech Route: {resp.status_code}")
            
    except Exception as e:
        print(f"Failed: {e}")

if __name__ == "__main__":
    asyncio.run(main())
