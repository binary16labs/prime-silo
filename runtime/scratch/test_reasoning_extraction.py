import sys
import os

# Add the project root to sys.path
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from benny.core.reasoning import extract_reasoning, format_combined_output

def test_extraction():
    test_cases = [
        {
            "name": "DeepSeek-R1 Style",
            "input": "<think>I need to search the graph for the most dependent nodes.</think>Here are the top 3 nodes with the most dependencies: ...",
            "expect_reasoning": "I need to search the graph for the most dependent nodes.",
            "expect_body": "Here are the top 3 nodes with the most dependencies: ..."
        },
        {
            "name": "DeepSeek-R1 Unclosed Tag",
            "input": "<think>I am thinking... The graph is large.The result is consistent with my query.",
            "expect_reasoning": "I am thinking... The graph is large.",
            "expect_body": "The result is consistent with my query."
        },
        {
            "name": "Yapping Style",
            "input": "Okay, let me process this. The user asked which code elements have the most dependencies.\n\nHere is the answer based on my research.",
            "expect_reasoning": "Okay, let me process this. The user asked which code elements have the most dependencies.",
            "expect_body": "Here is the answer based on my research."
        },
        {
            "name": "Mixed Style",
            "input": "<think>Searching...</think>Okay, let me process this.\n\nActually, here is the result.",
            "expect_reasoning": "Searching...",
            "expect_body": "Okay, let me process this.\n\nActually, here is the result."
        }
    ]

    for tc in test_cases:
        body, reasoning = extract_reasoning(tc["input"])
        print(f"--- Test: {tc['name']} ---")
        print(f"Reasoning: {reasoning}")
        print(f"Body: {body}")
        
        combined = format_combined_output(body, reasoning)
        print(f"Combined Output Highlight:\n{combined[:100]}...")
        print("\n")

if __name__ == "__main__":
    test_extraction()
