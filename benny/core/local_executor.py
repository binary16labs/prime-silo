"""
Local LLM Executor (LC-1..4) - Direct, short-circuit inference for local models.
"""
from __future__ import annotations

import json
import logging
import os
import time
from typing import AsyncIterator, Dict, Any, List, Optional, Protocol, Union

import httpx
import tiktoken

from .event_bus import event_bus
from .litert_engine import LiteRTEngine

logger = logging.getLogger(__name__)

# =============================================================================
# PROTOCOL (LC-1..4)
# =============================================================================

class LocalExecutor(Protocol):
    """Capability contract for local model execution."""
    
    async def generate(self, prompt: str, system: Optional[str] = None, **kwargs) -> str:
        """LC-1: Baseline text generation."""
        ...

    async def stream(self, prompt: str, system: Optional[str] = None, **kwargs) -> AsyncIterator[str]:
        """LC-2: Token streaming."""
        ...

    def count_tokens(self, text: str) -> int:
        """LC-3: Cost pre-flight."""
        ...

    async def embed(self, text: str) -> List[float]:
        """LC-4: Embeddings (optional)."""
        ...


# =============================================================================
# BASE EXECUTORS
# =============================================================================

class BaseLocalExecutor:
    """Shared logic for all local executors."""
    
    def __init__(self, model_id: str, provider_name: str):
        self.model_id = model_id
        self.provider_name = provider_name
        # Fallback to cl100k_base (GPT-4) as it's the most common density for modern models
        try:
            self.encoding = tiktoken.get_encoding("cl100k_base")
        except Exception:
            self.encoding = None

    def count_tokens(self, text: str) -> int:
        """LC-3: count tokens using tiktoken (OpenAI-standard)."""
        if not text:
            return 0
        if self.encoding:
            return len(self.encoding.encode(text))
        # Fallback to rough heuristic if tiktoken fails
        return len(text) // 4

    def _emit_usage(self, run_id: Optional[str], prompt: str, completion: str, duration_ms: int):
        """Emit resource_usage to the event bus for UI tracking."""
        if not run_id:
            return
        
        usage = {
            "prompt_tokens": self.count_tokens(prompt),
            "completion_tokens": self.count_tokens(completion),
            "total_tokens": self.count_tokens(prompt) + self.count_tokens(completion),
        }
        
        event_bus.emit(run_id, "resource_usage", {
            "model": self.model_id,
            "provider": f"local/{self.provider_name}",
            "usage": usage,
            "duration_ms": duration_ms,
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        })

class BaseOpenAICompatibleExecutor(BaseLocalExecutor):
    """HTTP-based executor for OpenAI-compatible local servers."""

    def __init__(self, model_id: str, provider_name: str, base_url: str, api_key: str = "not-needed"):
        super().__init__(model_id, provider_name)
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        # Use a longer default timeout for local models (LC-5.4)
        self.timeout = float(os.environ.get("BENNY_LLM_TIMEOUT", "900"))

    async def generate(self, prompt: str, system: Optional[str] = None, run_id: Optional[str] = None, **kwargs) -> str:
        start_ts = time.time()
        messages = []
        if system:
            messages.append({"role": "system", "content": system})
        messages.append({"role": "user", "content": prompt})

        async with httpx.AsyncClient(timeout=self.timeout) as client:
            payload = {
                "model": self.model_id,
                "messages": messages,
                "temperature": kwargs.get("temperature", 0.7),
                "max_tokens": kwargs.get("max_tokens", 4000),
                "stream": False
            }
            
            if "frequency_penalty" in kwargs:
                payload["frequency_penalty"] = kwargs["frequency_penalty"]
            if "presence_penalty" in kwargs:
                payload["presence_penalty"] = kwargs["presence_penalty"]
            if "repetition_penalty" in kwargs:
                payload["repetition_penalty"] = kwargs["repetition_penalty"]
                
            json_payload = payload
            resp = await client.post(
                f"{self.base_url}/chat/completions",
                headers={"Authorization": f"Bearer {self.api_key}"},
                json=json_payload
            )
            resp.raise_for_status()
            data = resp.json()
            # Defensive: some local servers (notably Lemonade with the FLM
            # recipe) return HTTP 200 with an error envelope instead of an
            # OpenAI ``choices`` payload — e.g. ``{"error": {"details":
            # {"response": {"error": {"message": "Max length reached!"}}}}}``.
            # Surface that upstream message instead of leaking ``KeyError:
            # 'choices'`` to the caller.
            if "choices" not in data:
                upstream = ""
                err = data.get("error") if isinstance(data, dict) else None
                if isinstance(err, dict):
                    inner = (
                        err.get("details", {}).get("response", {}).get("error", {})
                        if isinstance(err.get("details"), dict) else {}
                    )
                    upstream = (
                        (inner.get("message") if isinstance(inner, dict) else None)
                        or err.get("message")
                        or json.dumps(err)[:300]
                    )
                else:
                    upstream = json.dumps(data)[:300]
                raise RuntimeError(
                    f"{self.provider_name}/{self.model_id}: upstream returned no 'choices' "
                    f"(likely context-window or model error): {upstream}"
                )
            content = data["choices"][0]["message"]["content"]

            self._emit_usage(run_id, prompt, content, int((time.time() - start_ts) * 1000))
            return content

    async def stream(self, prompt: str, system: Optional[str] = None, run_id: Optional[str] = None, **kwargs) -> AsyncIterator[str]:
        messages = []
        if system:
            messages.append({"role": "system", "content": system})
        messages.append({"role": "user", "content": prompt})

        full_content = []
        start_ts = time.time()

        async with httpx.AsyncClient(timeout=self.timeout) as client:
            payload = {
                "model": self.model_id,
                "messages": messages,
                "temperature": kwargs.get("temperature", 0.7),
                "max_tokens": kwargs.get("max_tokens", 4000),
                "stream": True
            }
            
            if "frequency_penalty" in kwargs:
                payload["frequency_penalty"] = kwargs["frequency_penalty"]
            if "presence_penalty" in kwargs:
                payload["presence_penalty"] = kwargs["presence_penalty"]
            if "repetition_penalty" in kwargs:
                payload["repetition_penalty"] = kwargs["repetition_penalty"]
                
            json_payload = payload
            async with client.stream(
                "POST",
                f"{self.base_url}/chat/completions",
                headers={"Authorization": f"Bearer {self.api_key}"},
                json=json_payload
            ) as response:
                response.raise_for_status()
                async for line in response.aiter_lines():
                    if line.startswith("data: "):
                        if line[6:] == "[DONE]":
                            break
                        try:
                            chunk = json.loads(line[6:])
                            delta = chunk["choices"][0].get("delta", {}).get("content", "")
                            if delta:
                                full_content.append(delta)
                                yield delta
                        except json.JSONDecodeError:
                            continue
        
        self._emit_usage(run_id, prompt, "".join(full_content), int((time.time() - start_ts) * 1000))

# =============================================================================
# PROVIDER IMPLEMENTATIONS
# =============================================================================

class LemonadeExecutor(BaseOpenAICompatibleExecutor):
    def __init__(self, model: str):
        # Lemonade is at :13305 /v1
        super().__init__(model, "lemonade", "http://127.0.0.1:13305/v1")

class OllamaExecutor(BaseOpenAICompatibleExecutor):
    def __init__(self, model: str):
        # Ollama is at :11434 /v1
        super().__init__(model, "ollama", "http://127.0.0.1:11434/v1", api_key="ollama")

class OpenAICompatibleExecutor(BaseOpenAICompatibleExecutor):
    """Shared for LMStudio and FastFlowLM."""
    pass

class LiteRTExecutor(BaseLocalExecutor):
    """Wraps the LiteRT (MediaPipe) singleton engine."""
    
    def __init__(self, model: str):
        super().__init__(model, "litert")
        self.model_path = None
        if "/" in model:
            self.model_path = model.split("/", 1)[1]

    async def generate(self, prompt: str, system: Optional[str] = None, run_id: Optional[str] = None, **kwargs) -> str:
        start_ts = time.time()
        # LiteRT engine doesn't currently support a separate 'system' role in the generate call, 
        # so we prepend it to the prompt.
        full_prompt = f"{system}\n\n{prompt}" if system else prompt
        
        content = await LiteRTEngine.generate(full_prompt, model_path=self.model_path)
        
        self._emit_usage(run_id, prompt, content, int((time.time() - start_ts) * 1000))
        return content

    async def stream(self, prompt: str, system: Optional[str] = None, run_id: Optional[str] = None, **kwargs) -> AsyncIterator[str]:
        # LiteRT engine (MediaPipe LLM Inference) doesn't easily support token-by-token async streaming 
        # in the current mediapipe python wheel. We'll yield the whole string as one chunk for now 
        # to satisfy the protocol accurately.
        result = await self.generate(prompt, system, run_id, **kwargs)
        yield result


# =============================================================================
# RESOLVER
# =============================================================================

def resolve_executor(model_str: str) -> Optional[LocalExecutor]:
    """Map a model string to an in-process local executor."""
    if not model_str:
        return None
    
    model_lower = model_str.lower()
    
    # 1. Lemonade
    if model_lower.startswith("lemonade/"):
        return LemonadeExecutor(model_str.split("/", 1)[1])
    
    # 2. Ollama
    if model_lower.startswith("ollama/"):
        return OllamaExecutor(model_str.split("/", 1)[1])
    
    # 3. LiteRT
    if model_lower.startswith("litert/"):
        return LiteRTExecutor(model_str)
    
    # 4. LMStudio / FastFlowLM
    if model_lower.startswith("lmstudio/"):
        # Port 1234
        return OpenAICompatibleExecutor(model_str.split("/", 1)[1], "lmstudio", "http://127.0.0.1:1234/v1")
    
    if model_lower.startswith("fastflowlm/"):
        # Port 52625
        return OpenAICompatibleExecutor(model_str.split("/", 1)[1], "fastflowlm", "http://127.0.0.1:52625/v1")
    
    return None
