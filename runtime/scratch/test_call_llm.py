import asyncio
from benny.synthesis.engine import call_llm

async def main():
    print("Testing call_llm...")
    try:
        response = await call_llm(
            prompt="Hello, return a tiny JSON object:\n```json\n{\"test\": 123}\n```", 
            provider="lemonade", 
            model="deepseek-r1-8b-FLM"
        )
        print("Response:")
        print(response)
    except Exception as e:
        print("Error:")
        print(e)
        
if __name__ == "__main__":
    asyncio.run(main())
