"""
Reasoning Extraction Utility - Separates internal monologue from final response.
Supports <think> tags and common conversational preambles.
"""

import re
from typing import Tuple, Optional

def extract_reasoning(text: str) -> Tuple[str, str]:
    """
    Extract reasoning blocks from model output.
    Returns: (cleaned_body, extracted_reasoning)
    """
    reasoning = ""
    body = text

    # 1. Handle <think> blocks (DeepSeek-R1 style)
    think_match = re.search(r'<think>(.*?)(?:</think>|$)', body, re.DOTALL)
    if think_match:
        reasoning = think_match.group(1).strip()
        body = re.sub(r'<think>.*?</think>', '', body, flags=re.DOTALL).strip()
        # Handle cases where think tag wasn't closed correctly
        if reasoning and body == text:
             body = re.sub(r'<think>.*$', '', body, flags=re.DOTALL).strip()

    # 2. Handle common yapping preambles if no reasoning was found via tags
    if not reasoning:
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
