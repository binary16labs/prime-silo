"""
Multi-Model Orchestration - LiteLLM integration with local/cloud providers
"""

import os
import httpx
from typing import Optional, Dict, Any, List
from litellm import completion
import logging
from .litert_engine import LiteRTEngine
from ..governance.lineage import track_llm_call
from ..governance.operating_manual import build_system_prompt_augmentation
from .event_bus import event_bus
from datetime import datetime

logger = logging.getLogger(__name__)


# =============================================================================
# PRECONFIGURED LOCAL LLM PROVIDERS
# =============================================================================

LOCAL_PROVIDERS: Dict[str, Dict[str, Any]] = {
    "lemonade": {
        "name": "Lemonade",
        "port": 13305,
        "base_url": "http://localhost:13305/api/v1",
        "api_key": "not-needed",
        "description": "AMD NPU accelerated inference",
        "startup_cmd": "LemonadeServer.exe serve --port 13305",
        "check_url": "http://localhost:13305/api/v1/models"
    },
    "ollama": {
        "name": "Ollama",
        "port": 11434,
        "base_url": "http://localhost:11434/v1",
        "api_key": "ollama",
        "description": "Popular local LLM server",
        "startup_cmd": "ollama serve",
        "check_url": "http://localhost:11434/v1/models"
    },
    "fastflowlm": {
        "name": "FastFlowLM",
        "port": 52625,
        "base_url": "http://localhost:52625/v1",
        "api_key": "not-needed",
        "description": "Intel NPU accelerated inference",
        "startup_cmd": None,  # Manual start required
        "check_url": "http://localhost:52625/v1/models"
    },
    "lmstudio": {
        "name": "LM Studio",
        "port": 1234,
        "base_url": "http://127.0.0.1:1234/v1",
        "api_key": "not-needed",
        "description": "Popular local LLM desktop application",
        "startup_cmd": None,  # Usually started manually by user
        "check_url": "http://127.0.0.1:1234/v1/models"
    },
    "litert": {
        "name": "LiteRT (MediaPipe)",
        "port": 0,  # Internal library call
        "base_url": "local://litert",
        "api_key": "not-needed",
        "description": "On-device LiteRT/TFLite inference (supports NPU/GPU)",
        "startup_cmd": None,
        "check_url": None
    }

}



# =============================================================================
# MODEL REGISTRY (Cloud + Local)
# =============================================================================

MODEL_REGISTRY: Dict[str, Dict[str, Any]] = {
    # Cloud models for high-quality reasoning
    "reasoning": {
        "model": "gpt-4-turbo",
        "provider": "openai",
        "cost_per_1k": 0.01,
        "use_for": ["planning", "complex_analysis"]
    },
    "writing": {
        "model": "claude-3-sonnet-20240229",
        "provider": "anthropic",
        "cost_per_1k": 0.003,
        "use_for": ["content_generation", "summarization"]
    },
    "fast": {
        "model": "gpt-3.5-turbo",
        "provider": "openai",
        "cost_per_1k": 0.0005,
        "use_for": ["simple_tasks", "classification"]
    },
    # Local models for privacy and cost savings
    "local_lemonade": {
        "model": "openai/deepseek-r1-8b-FLM",
        "provider": "lemonade",
        "cost_per_1k": 0.0,
        "use_for": ["offline", "sensitive_data", "testing"]
    },
    "local_ollama": {
        "model": "ollama/llama3",
        "provider": "ollama",
        "cost_per_1k": 0.0,
        "use_for": ["offline", "sensitive_data"]
    },
    "local_fastflow": {
        "model": "openai/deepseek-r1:8b",
        "provider": "fastflowlm",
        "cost_per_1k": 0.0,
        "use_for": ["intel_npu", "offline", "testing", "reasoning"]
    },
    "local_lmstudio": {
        "model": "openai/Gemma-4-E4B-it-GGUF", # Optimized ID for Lemonade-compatible requests
        "provider": "lmstudio",
        "cost_per_1k": 0.0,
        "use_for": ["offline", "sensitive_data", "testing", "reasoning"]
    },
    "local_litert": {
        "model": "litert/gemma-4-E4B-it.litertlm",
        "provider": "litert",
        "cost_per_1k": 0.0,
        "use_for": ["on-device", "offline", "npu-accelerated", "testing", "gemma-4"]
    }
}



def configure_local_provider(provider: str = "ollama", port: Optional[int] = None) -> Dict[str, Any]:
    """
    Configure environment for local LLM provider.
    
    Args:
        provider: Provider name (lemonade, ollama, fastflowlm)
        port: Optional custom port override
        
    Returns:
        Configuration dict with provider details
    """
    config = LOCAL_PROVIDERS.get(provider, LOCAL_PROVIDERS["ollama"])
    actual_port = port or config["port"]
    
    base_url = config["base_url"].replace(str(config["port"]), str(actual_port))
    os.environ["OPENAI_API_BASE"] = base_url
    os.environ["OPENAI_API_KEY"] = config["api_key"]
    
    return {
        "provider": provider,
        "port": actual_port,
        "base_url": base_url,
        "name": config["name"]
    }


def get_model_for_task(task_type: str) -> str:
    """
    Intelligent model routing based on task type.
    
    Args:
        task_type: Type of task (planning, summarization, offline, etc.)
        
    Returns:
        Model identifier string for LiteLLM
    """
    for profile in MODEL_REGISTRY.values():
        if task_type in profile["use_for"]:
            return profile["model"]
    return MODEL_REGISTRY["reasoning"]["model"]


def get_available_models() -> List[Dict[str, Any]]:
    """Get list of all configured models with metadata"""
    return [
        {
            "id": key,
            "model": profile["model"],
            "provider": profile["provider"],
            "cost_per_1k": profile["cost_per_1k"],
            "use_for": profile["use_for"]
        }
        for key, profile in MODEL_REGISTRY.items()
    ]


def get_model_config(model_id: str) -> Dict[str, Any]:
    """
    Get configuration for a specific model.
    
    Args:
        model_id: Model ID or LiteLLM model string
        
    Returns:
        Model configuration dict with base_url and api_key if local
    """
    # Check if it's a registered model ID
    if model_id in MODEL_REGISTRY:
        profile = MODEL_REGISTRY[model_id]
        provider = profile["provider"]
        model = profile["model"]
    else:
        # Parse LiteLLM model string like "ollama/llama3"
        if "/" in model_id and not model_id.startswith("openai/"):
            provider = model_id.split("/")[0]
            model = "/".join(model_id.split("/")[1:])
            
            # Map common prefixes to actual providers
            provider_map = {
                "amd": "lemonade",
                "fastflow": "fastflowlm"
            }
            provider = provider_map.get(provider.lower(), provider)
        else:
            # Heuristic: If it looks like a local model (GGUF, FLM, -it), 
            # and no provider is specified, default to lemonade.
            local_hints = ["gguf", "flm", "it-", "llama3", "phi-3", "qwen"]
            if any(hint in model_id.lower() for hint in local_hints):
                provider = "lemonade"
            else:
                provider = "openai"
            model = model_id
    
    config = {
        "model": model,
        "provider": provider
    }
    
    # Add local provider configuration
    if provider in LOCAL_PROVIDERS:
        local_config = LOCAL_PROVIDERS[provider]
        config["base_url"] = local_config["base_url"]
        config["api_key"] = local_config["api_key"]
        
        # Aggressive prefixing for LiteLLM compatibility
        # LiteLLM needs 'openai/' to trigger the OpenAI-compatible client for custom base_urls
        # BUT Lemonade is strict and doesn't want the prefix in the JSON body 'model' field.
        if not config["model"].startswith("openai/") and provider in ["ollama", "fastflowlm", "lmstudio"]:
            model_core = config["model"]
            if "/" in model_core and not model_core.startswith("openai/"):
                 model_core = model_core.split("/")[-1]
            config["model"] = f"openai/{model_core}"
        elif provider == "lemonade":
            # Lemonade prefers raw IDs
            pass
    
    # Fallback: if we defaulted to openai but have lemonade running, it might be that.
    elif provider == "openai" and any(hint in model_id.lower() for hint in ["gguf", "flm", "hybrid"]):
         config["provider"] = "lemonade"
         local_config = LOCAL_PROVIDERS["lemonade"]
         config["base_url"] = local_config["base_url"]
         config["api_key"] = local_config["api_key"]
         # No prefix for lemonade
    
    return config


async def get_active_model(workspace_id: str = "default") -> str:
    """
    Get the first available model by checking workspace manifest, then probing providers.
    
    Priority:
    1. Workspace default_model from manifest.yaml
    2. Auto-detect which provider is actually running by probing check URLs
    3. Raise error if nothing available
    
    Args:
        workspace_id: Workspace identifier
        
    Returns:
        Model identifier string (e.g., "lmstudio/gemma-2-27b")
        
    Raises:
        Exception if no model available and default_model is null
    """
    from .workspace import load_manifest
    
    # Priority 1: Load workspace manifest and use default_model if set
    try:
        manifest = load_manifest(workspace_id)
        if manifest.default_model:
            print(f"✓ Using workspace default_model: {manifest.default_model}")
            return manifest.default_model
    except Exception as e:
        logging.warning(f"Could not load manifest for {workspace_id}: {e}")
    
    # Priority 2: Probe each local provider to see which is running
    print(f"No default_model set for {workspace_id}. Auto-detecting available providers...")
    probe_order = ["lmstudio", "lemonade", "ollama", "fastflowlm"]
    
    try:
        async with httpx.AsyncClient(timeout=2.0) as client:
            for provider_name in probe_order:
                if provider_name not in LOCAL_PROVIDERS:
                    continue
                
                provider = LOCAL_PROVIDERS[provider_name]
                check_url = provider.get("check_url")
                
                if not check_url:
                    continue
                
                try:
                    response = await client.get(check_url)
                    if response.status_code == 200:
                        data = response.json()
                        models = data.get("data", [])
                        if models:
                            # Selection Logic:
                            # 1. Prioritize models with 'tool-calling' label AND size < 10GB
                            # 2. Fallback to any 'tool-calling' model
                            # 3. Fallback to first model
                            suitable_models = [m for m in models if "tool-calling" in m.get("labels", [])]
                            
                            if suitable_models:
                                # Try to find a small one first (< 10GB)
                                small_suitable = [m for m in suitable_models if m.get("size", 0) < 10.0]
                                if small_suitable:
                                    best_model = small_suitable[0]
                                else:
                                    best_model = suitable_models[0]
                            else:
                                best_model = models[0]
                            
                            model_id = best_model.get("id", best_model)
                            result = f"{provider_name}/{model_id}"
                            print(f"✓ Auto-detected active provider {provider_name}: {result}")
                            return result
                except Exception as e:
                    print(f"DEBUG: Provider {provider_name} probe failed: {e}")
                    logging.debug(f"Provider {provider_name} not available: {e}")
                    continue
    except Exception as e:
        print(f"DEBUG: Critical error in get_active_model: {e}")
        logger.error(f"Error probing providers: {e}")
    
    # Priority 3: Fallback to the first provider that we might have a preset for
    # (Optional: we could just return a default like reasoning)
    
    # Priority 4: Fallback error
    error_msg = (
        f"No active LLM provider found and no default_model set in "
        f"workspace '{workspace_id}' manifest.yaml. \n"
        f"Please either:\n"
        f"  1. Set 'default_model' in {workspace_id}/manifest.yaml, or\n"
        f"  2. Ensure one of these providers is running: \n"
        f"     - LM Studio (port 1234)\n"
        f"     - Lemonade (port 13305)\n"
        f"     - Ollama (port 11434)\n"
        f"     - FastFlowLM (port 52625)"
    )
    logger.error(f"[LLM_MANAGER] {error_msg}")
    raise Exception(error_msg)


async def call_model(
    model: str,
    messages: List[Dict[str, str]],
    temperature: float = 0.7,
    max_tokens: int = 1000,
    fallbacks: Optional[List[str]] = None,
    timeout: Optional[float] = None,
    run_id: Optional[str] = None
) -> str:
    """
    Call LLM with fallback support.
    
    Args:
        model: Model identifier
        messages: Chat messages
        temperature: Sampling temperature
        max_tokens: Max tokens to generate
        fallbacks: Fallback models if primary fails
        
    Returns:
        Generated text response
    """
    # Operating Manual: Prepend identity and rules to the system prompt
    # Extract workspace_id from messages if present (assuming meta or context might have it, 
    # but for now we often pass it in run_id or it's 'default').
    # For now, we'll try to find 'workspace' in the messages or use 'default'.
    workspace_id = "default"
    for msg in messages:
        if msg.get("role") == "system" and "workspace:" in msg.get("content", ""):
            import re
            match = re.search(r"workspace:\s*(\S+)", msg["content"])
            if match:
                workspace_id = match.group(1)
                break
    
    augmentation = build_system_prompt_augmentation(workspace_id)
    if augmentation:
        # Find the system prompt and prepend to it, or create one if missing
        system_found = False
        for i, msg in enumerate(messages):
            if msg.get("role") == "system":
                messages[i]["content"] = augmentation + msg.get("content", "")
                system_found = True
                break
        
        if not system_found:
            messages.insert(0, {"role": "system", "content": augmentation})

    # Handle internal LiteRT (MediaPipe) inference
    if model.startswith("litert/") or "/litert" in model or (isinstance(model, str) and "litert" in model.lower()):
        # Extract model path if provided, else use default in initialize()
        model_path = None
        if "litert/" in model:
            # model string like "litert/path/to/model.bin"
            model_path = model.split("litert/", 1)[1]
            
        try:
            if not LiteRTEngine.is_available():
                # Fallback to Lemonade (AMD NPU) if local MediaPipe is not supported
                print(f"LiteRT engine unavailable. Redirecting {model} fallback to Lemonade NPU provider.")
                
                # Determine the best matching model ID on Lemonade
                target_model = "openai/deepseek-r1-8b-FLM" # Default
                if "gemma-4" in model.lower():
                    target_model = "openai/Gemma-4-E4B-it-GGUF"
                elif "deepseek" in model.lower():
                    target_model = "openai/deepseek-r1-8b-FLM"
                elif "llama" in model.lower():
                    target_model = "openai/llama3.2-1b-FLM"

                lemonade_config = LOCAL_PROVIDERS["lemonade"]
                from litellm import completion
                response = completion(
                    model=target_model,
                    messages=messages,
                    api_base=lemonade_config["base_url"],
                    api_key=lemonade_config["api_key"],
                    temperature=temperature
                )
                
                # Track fallback call
                if run_id:
                    track_llm_call(
                        parent_run_id=run_id,
                        model=target_model,
                        provider="lemonade",
                        usage=response.get("usage")
                    )
                return response.choices[0].message.content

            return await LiteRTEngine.generate(prompt=messages[-1]["content"], model_path=model_path)
        except Exception as e:
            if not fallbacks:
                raise e
            print(f"LiteRT inference failed, trying fallbacks: {e}")

    print(f"DEBUG: call_model(model='{model}', ...)")
    try:
        config = get_model_config(model)
        print(f"DEBUG: get_model_config result: {config}")
        
        provider = config.get("provider", "openai").lower()
        litellm_model = config["model"]
        
        # The prefixing logic is now handled in get_model_config for consistency
        # but we keep this as a safety check for direct model string inputs
        local_mapping = ["lemonade", "fastflowlm", "lmstudio", "ollama"]
        if provider in local_mapping or "base_url" in config:
            if not litellm_model.startswith("openai/"):
                if "/" in litellm_model:
                    litellm_model = f"openai/{litellm_model.split('/')[-1]}"
                else:
                    litellm_model = f"openai/{litellm_model}"
                print(f"DEBUG: Transform to litellm_model='{litellm_model}'")
        
        kwargs = {
            "model": litellm_model,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
            "fallbacks": fallbacks or []
        }
        
        if "base_url" in config and config["base_url"]:
            kwargs["api_base"] = config["base_url"]
        if "api_key" in config and config["api_key"]:
            kwargs["api_key"] = config["api_key"]
        
        if timeout:
            kwargs["timeout"] = timeout
            
        from litellm import completion
        print(f"DEBUG: FINAL LiteLLM call: completion(model='{litellm_model}', api_base='{kwargs.get('api_base')}')")
        response = completion(**kwargs)
        
        # Emit Resource Usage for UI
        try:
             usage = response.get("usage", {})
             duration_ms = response.get("response_ms", 0) # litellm sometimes provides this
             
             # Convert LiteLLM Usage object to dict for JSON serialization
             usage_data = usage if isinstance(usage, dict) else (usage.model_dump() if hasattr(usage, 'model_dump') else dict(usage))
             
             event_bus.emit(run_id, "resource_usage", {
                 "model": litellm_model,
                 "provider": provider,
                 "usage": usage_data,
                 "duration_ms": duration_ms,
                 "timestamp": datetime.now().isoformat()
             })
        except Exception as e:
             logging.debug(f"Failed to emit resource_usage: {e}")

        return response.choices[0].message.content
    except Exception as e:
        print(f"DEBUG: call_model failed: {e}")
        if fallbacks and len(fallbacks) > 0:
            print(f"DEBUG: Primary model failed, trying fallbacks: {fallbacks}")
            for fallback in fallbacks:
                try:
                    # Recursive call to call_model for fallback to ensure it gets same routing logic
                    return await call_model(
                        model=fallback,
                        messages=messages,
                        temperature=temperature,
                        max_tokens=max_tokens,
                        timeout=timeout,
                        run_id=run_id
                    )
                except:
                    continue
        raise e
