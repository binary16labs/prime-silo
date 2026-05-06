"""
Context Guard Service — Centralized token and context management.
Prevents 'Max length reached' errors by enforcing provider-specific thresholds
and intelligent truncation of tool outputs and message history.
"""

import logging
from typing import List, Dict, Any, Optional
from dataclasses import dataclass
from .models import get_model_config

logger = logging.getLogger(__name__)

@dataclass
class ContextProfile:
    """Thresholds for a specific model class."""
    max_total_chars: int
    max_tool_output_chars: int
    max_rag_context_chars: int
    prune_percentage: float = 0.2  # Amount of history to drop when full

# Default profiles
PROFILES = {
    "local": ContextProfile(
        max_total_chars=12000,      # Approx 3k-4k tokens
        max_tool_output_chars=2500, # Guard against massive JSON
        max_rag_context_chars=3000,
    ),
    "cloud": ContextProfile(
        max_total_chars=100000,     # For GPT-4 / Claude
        max_tool_output_chars=20000,
        max_rag_context_chars=15000,
    )
}

class ContextGuard:
    """Orchestrates context management across the Benny pipeline."""
    
    @staticmethod
    def get_profile(model: str) -> ContextProfile:
        """Resolve the context profile based on the model/provider."""
        try:
            config = get_model_config(model)
            provider = config.get("provider", "openai").lower()
            
            local_providers = ["lemonade", "ollama", "fastflowlm", "lmstudio", "litert"]
            if provider in local_providers:
                return PROFILES["local"]
            return PROFILES["cloud"]
        except Exception:
            return PROFILES["local"] # Safe default

    @staticmethod
    def guard_string(text: str, limit: int, source_hint: str = "data") -> str:
        """Truncate a string with a descriptive marker if it exceeds limit."""
        if not text or len(text) <= limit:
            return text
        
        truncated = text[:limit]
        marker = f"\n\n✂️ [TRUNCATED {len(text) - limit} chars of {source_hint} for context stability] ✂️"
        return truncated + marker

    @staticmethod
    def prepare_payload(messages: List[Dict[str, str]], model: str) -> List[Dict[str, str]]:
        """
        Final pre-flight check for message history.
        Prunes older messages if the total payload exceeds the model's budget.
        """
        profile = ContextGuard.get_profile(model)
        
        # Calculate total size
        total_size = sum(len(m.get("content", "")) for m in messages)
        
        if total_size <= profile.max_total_chars:
            return messages
        
        logger.warning(f"[CONTEXT_GUARD] Payload size {total_size} exceeds budget {profile.max_total_chars}. Pruning history.")
        
        # Pruning Logic:
        # 1. Keep System Prompt (usually index 0)
        # 2. Keep the most recent User/Assistant turn
        # 3. Prune middle tool results first as they are often the largest
        
        preserved = []
        if messages and messages[0]["role"] == "system":
            preserved.append(messages[0])
            messages_to_prune = messages[1:]
        else:
            messages_to_prune = messages
            
        # Keep the last 2 messages (usually the latest Turn)
        tail_count = 2 if len(messages_to_prune) >= 2 else 1
        tail = messages_to_prune[-tail_count:]
        middle = messages_to_prune[:-tail_count]
        
        # Truncate middle messages aggressively
        pruned_middle = []
        for msg in middle:
            # If it's a tool result, truncate it heavily
            limit = profile.max_tool_output_chars // 2
            content = ContextGuard.guard_string(msg.get("content", ""), limit, f"historic_{msg['role']}")
            pruned_middle.append({**msg, "content": content})
            
        return preserved + pruned_middle + tail

# Global singleton or helper methods
def guard_tool_output(result: Any, model: str, tool_name: str = "tool") -> str:
    """Helper for SkillRegistry to safe-wrap tool results."""
    profile = ContextGuard.get_profile(model)
    res_str = str(result)
    return ContextGuard.guard_string(res_str, profile.max_tool_output_chars, tool_name)
