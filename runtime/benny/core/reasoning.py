"""
Reasoning Extraction Utility - Separates internal monologue from final response.
Supports <think> tags, stray </think> tags, and tagless thinking (Qwen3 via Lemonade).
"""

import re
from typing import Tuple, Optional


def extract_reasoning(text: str) -> Tuple[str, str]:
    """
    Extract reasoning blocks from model output.
    Returns: (cleaned_body, extracted_reasoning)

    Handles:
    - <think>...</think> blocks (DeepSeek-R1 / Qwen3 explicit style)
    - Stray </think> with no opener (model emits only closing tag)
    - Tagless thinking mode (Qwen3 via Lemonade: raw prose before JSON body)
    """
    reasoning = ""
    body = text

    # 1. Full <think>...</think> block (explicit tags, most reliable)
    think_match = re.search(r'<think>(.*?)(?:</think>|$)', body, re.DOTALL)
    if think_match:
        reasoning = think_match.group(1).strip()
        body = re.sub(r'<think>.*?</think>', '', body, flags=re.DOTALL).strip()
        # Handle unclosed tag edge case
        if reasoning and body == text:
            body = re.sub(r'<think>.*$', '', body, flags=re.DOTALL).strip()
        return body, reasoning

    # 2. Stray </think> with no opener — split on it
    if '</think>' in body:
        parts = body.split('</think>', 1)
        reasoning = parts[0].strip()
        body = parts[1].strip()
        return body, reasoning

    # 3. Tagless thinking mode (Qwen3 via Lemonade).
    #    The model outputs raw reasoning prose BEFORE the JSON without any tags.
    #    Any text preceding the first JSON boundary character is treated as reasoning.
    json_start = -1
    for i, ch in enumerate(body):
        if ch in '{[':
            json_start = i
            break

    if json_start > 0:
        reasoning = body[:json_start].strip()
        body = body[json_start:]
        return body, reasoning

    # 4. Preamble patterns (legacy fallback for chatty models)
    preamble_patterns = [
        r"^(Okay, let me process this\..*?)\n\n",
        r"^(I will analyze the request\..*?)\n\n",
        r"^(Let me think about this\..*?)\n\n",
    ]
    for pattern in preamble_patterns:
        match = re.search(pattern, body, re.DOTALL | re.IGNORECASE)
        if match:
            reasoning = match.group(1).strip()
            body = body[match.end():].strip()
            break

    return body, reasoning


def format_combined_output(body: str, reasoning: str) -> str:
    """
    Formats the response to show both reasoning and body clearly.
    """
    if not reasoning:
        return body

    header = "### [THINKING] Internal Reasoning\n"
    formatted_reasoning = f"> {reasoning.replace(chr(10), chr(10) + '> ')}\n\n"
    separator = "---\n\n"

    return f"{header}{formatted_reasoning}{separator}{body}"
