import asyncio
from benny.core.models import get_model_config, call_model

async def test_routing():
    model_id = "Gemma-4-E4B-it-GGUF"
    print(f"Testing model_id: {model_id}")
    config = get_model_config(model_id)
    print(f"Config: {config}")
    
    # Simulate call_model transformation
    provider = config.get("provider", "openai").lower()
    litellm_model = config["model"]
    local_mapping = ["lemonade", "fastflowlm", "lmstudio", "ollama"]
    
    if provider in local_mapping or "base_url" in config:
        if not litellm_model.startswith("openai/"):
            if "/" in litellm_model:
                litellm_model = f"openai/{litellm_model.split('/')[-1]}"
            else:
                litellm_model = f"openai/{litellm_model}"
    
    print(f"Final litellm_model: {litellm_model}")
    print(f"API Base: {config.get('base_url')}")

if __name__ == "__main__":
    asyncio.run(test_routing())
