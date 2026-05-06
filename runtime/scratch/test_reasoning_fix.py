import sys
sys.path.insert(0, '.')
from benny.core.reasoning import extract_reasoning
import json

# Test 1: tagless thinking mode (Qwen3/Lemonade)
body, reasoning = extract_reasoning(
    "First I need to think about this.\n\n" + '{"tasks":[{"task_id":"t1"}]}'
)
parsed = json.loads(body)
assert len(parsed["tasks"]) == 1, "Test 1 failed: wrong task count"
assert "First I need" in reasoning, "Test 1 failed: reasoning not captured"
print("Test 1 PASS: tagless thinking stripped correctly")

# Test 2: explicit <think> tags
body2, reasoning2 = extract_reasoning("<think>I am thinking</think>" + '{"tasks":[]}')
assert body2.strip() == '{"tasks":[]}', f"Test 2 failed: body={body2!r}"
assert "I am thinking" in reasoning2, "Test 2 failed: reasoning missing"
print("Test 2 PASS: explicit think tags work")

# Test 3: no reasoning, pure JSON
body3, reasoning3 = extract_reasoning('{"tasks":[{"task_id":"t1"}]}')
parsed3 = json.loads(body3)
assert len(parsed3["tasks"]) == 1
assert reasoning3 == ""
print("Test 3 PASS: clean JSON unchanged")

# Test 4: stray </think>
body4, reasoning4 = extract_reasoning("Some thinking\n</think>\n" + '{"tasks":[]}')
assert body4.strip().startswith("{"), f"Test 4 failed: body={body4!r}"
print("Test 4 PASS: stray </think> handled")

print("\nAll tests passed!")
