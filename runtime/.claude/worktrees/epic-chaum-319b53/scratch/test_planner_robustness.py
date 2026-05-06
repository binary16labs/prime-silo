import sys
import os
import json
import asyncio
from pathlib import Path

# Add project root to sys.path
sys.path.append(os.getcwd())

from benny.core.skill_registry import registry
from benny.graph.swarm import parse_json_safe

def test_json_parsing():
    print("--- Testing JSON Parsing ---")
    
    # Case 1: Markdown block
    case1 = "```json\n{\"tasks\": [{\"id\": 1}]}\n```"
    print(f"Case 1: {parse_json_safe(case1)}")
    
    # Case 2: Truncated
    case2 = "{\"tasks\": [{\"id\": 1}"
    # Let's see what parse_json_safe does internally
    from benny.graph.swarm import parse_json_safe as pjs
    print(f"Case 2 input: {case2}")
    try:
        res = pjs(case2)
        print(f"Case 2 result: {res}")
    except Exception as e:
        print(f"Case 2 FAILED: {e}")
    
    # Case 3: Messy content
    case3 = "Here is the response: ``` {\"tasks\": []} ``` Hope this helps!"
    print(f"Case 3: {parse_json_safe(case3)}")

async def test_skill_loader():
    print("\n--- Testing Skill Loader ---")
    workspace = "test4"
    skills = registry.get_all_skills(workspace)
    
    print(f"Found {len(skills)} skills for workspace '{workspace}'")
    for s in skills:
        print(f"- ID: {s.id}")
        print(f"  Name: {s.name}")
        print(f"  Description: {s.description}")
        print(f"  Category: {s.category}")
        print(f"  Has Content: {bool(s.content)}")
        if s.id == "risk-officer":
            print(f"  First 50 chars of content: {s.content[:50]}...")
            print(f"  Metadata: {s.metadata}")

if __name__ == "__main__":
    test_json_parsing()
    asyncio.run(test_skill_loader())
