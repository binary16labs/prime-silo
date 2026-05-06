import asyncio
from benny.synthesis.engine import call_llm, DIRECTED_EXTRACTION_PROMPT, _parse_json_from_llm

async def main():
    print("Testing extraction...")
    prompt = DIRECTED_EXTRACTION_PROMPT.format(
        direction_prompt="",
        section_title="Neurobiology of Focus",
        text="The prefrontal cortex modulates impulse control by acting as a top-down regulator of dopamine."
    )
    try:
        raw = await call_llm(
            prompt=prompt, 
            provider="lemonade", 
            model="deepseek-r1-8b-FLM"
        )
        print("RAW RESPONSE:")
        print(raw)
        print("\n\nPARSED JSON:")
        parsed = _parse_json_from_llm(raw)
        print(parsed)
    except Exception as e:
        print("Error:")
        print(e)
        
if __name__ == "__main__":
    asyncio.run(main())
