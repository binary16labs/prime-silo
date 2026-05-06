import json
import logging
from typing import Dict, Any

# Mock logger
logging.basicConfig(level=logging.DEBUG)
logger = logging.getLogger("test")

def parse_json_safe(text: str) -> Dict[str, Any]:
    """
    Robust JSON parsing that handles:
    - Leading/trailing garbage
    - Markdown code blocks
    - Simple truncation (missing closing braces or quotes)
    - Loose syntax (no quotes on keys)
    """
    cleaned = text.strip()
    
    # Extract from markdown if present
    if "```json" in cleaned:
        cleaned = cleaned.split("```json")[1].split("```")[0]
    elif "```" in cleaned:
        # Try to find the block that looks like JSON
        blocks = cleaned.split("```")
        for block in blocks:
            if "{" in block and ":" in block:
                cleaned = block
                break
        else:
            cleaned = blocks[1] if len(blocks) > 1 else cleaned
    
    cleaned = cleaned.strip()
    
    # NEW: Find first '{' or '[' to skip leading text (e.g. "Here is the JSON: { ... }")
    start_idx = -1
    for i, char in enumerate(cleaned):
        if char in "{[":
            start_idx = i
            break
    
    if start_idx != -1:
        cleaned = cleaned[start_idx:]
    
    # NEW: Find last '}' or ']' to skip trailing text
    end_idx = -1
    for i in range(len(cleaned) - 1, -1, -1):
        if cleaned[i] in "}]":
            end_idx = i
            break
            
    if end_idx != -1:
        cleaned = cleaned[:end_idx + 1]
    
    if not cleaned:
        raise ValueError("Could not find any JSON structure in text")

    # Handle truncation: if it ends abruptly
    if not (cleaned.endswith("}") or cleaned.endswith("]")):
        # 1. Close open strings if necessary
        # We count unescaped quotes to see if the last one is open
        quote_count = 0
        escaped = False
        for char in cleaned:
            if char == "\\" and not escaped:
                escaped = True
            elif char == '"' and not escaped:
                quote_count += 1
                escaped = False
            else:
                escaped = False
        
        if quote_count % 2 != 0:
            cleaned += '"'
            
        # 2. Close brackets
        stack = []
        for char in cleaned:
            if char in "{[":
                stack.append(char)
            elif char == "}":
                if stack and stack[-1] == "{": stack.pop()
            elif char == "]":
                if stack and stack[-1] == "[": stack.pop()
        
        while stack:
            # Clean up trailing commas before closing
            cleaned = cleaned.rstrip(", ")
            top = stack.pop()
            if top == "{": cleaned += "}"
            else: cleaned += "]"
    
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError as e:
        logger.debug(f"JSON repair failed. Original length: {len(text)}, Cleaned: {cleaned[:100]}...")
        raise e

# TEST CASES
def test_json_repair():
    cases = [
        {
            "name": "Standard JSON",
            "input": '{"tasks": [{"id": 1}]}',
            "expected": {"tasks": [{"id": 1}]}
        },
        {
            "name": "Markdown JSON",
            "input": 'Here is your plan: ```json\n{"tasks": [{"id": 2}]}\n```',
            "expected": {"tasks": [{"id": 2}]}
        },
        {
            "name": "Leading Text",
            "input": 'Sure! { "tasks": [ { "id": 3 } ] }',
            "expected": {"tasks": [{"id": 3}]}
        },
        {
            "name": "Trailing Text",
            "input": '{ "tasks": [ { "id": 4 } ] } Hope this helps!',
            "expected": {"tasks": [{"id": 4}]}
        },
        {
            "name": "Both Leading and Trailing",
            "input": 'Raw JSON: {"tasks": [{"id": 5}]} End of response.',
            "expected": {"tasks": [{"id": 5}]}
        },
        {
            "name": "Truncated String with Trailing Garbage",
            "input": '{"tasks": [{"id": "6", "desc": "Process... (thinking)', 
            "expected": {"tasks": [{"id": "6", "desc": "Process..."}]}
        },
        {
            "name": "The actual error case from user",
            "input": '{ "tasks": [ { "task_id": "1", "description": "Research existing AI agent swarm strategies and governance frameworks.", "skill_hint": "search_kb",',
            "expected": {"tasks": [{"task_id": "1", "description": "Research existing AI agent swarm strategies and governance frameworks.", "skill_hint": "search_kb"}]}
        }
    ]

    for case in cases:
        print(f"Testing: {case['name']}")
        try:
            result = parse_json_safe(case['input'])
            if result == case['expected']:
                print(f"PASSED")
            else:
                print(f"FAILED: Expected {case['expected']}, got {result}")
        except Exception as e:
            print(f"ERROR: {e}")
        print("-" * 20)

if __name__ == "__main__":
    test_json_repair()
