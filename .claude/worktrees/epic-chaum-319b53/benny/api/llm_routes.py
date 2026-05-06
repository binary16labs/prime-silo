"""
LLM Management Routes - Start/stop/status for local LLM providers
"""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional, Dict, Any
import subprocess
import httpx
import asyncio

from ..core.models import LOCAL_PROVIDERS
from ..core.litert_engine import LiteRTEngine


router = APIRouter()


# =============================================================================
# SERVICE COMMANDS (Windows)
# =============================================================================

SERVICE_COMMANDS = {
    "ollama": {
        "start": "ollama serve",
        "stop": "taskkill /IM ollama.exe /F",
        "check": "http://localhost:11434/v1/models"
    },
    "lemonade": {
        "start": "LemonadeServer.exe serve --port 13305",
        "stop": 'taskkill /FI "WINDOWTITLE eq lemonade*" /F',
        "check": "http://localhost:13305/api/v1/models"
    },
    "fastflowlm": {
        "start": None,  # Manual start required
        "stop": None,
        "check": "http://localhost:52625/v1/models"
    },
    "lmstudio": {
        "start": None,  # Usually started manually by user
        "stop": None,
        "check": "http://127.0.0.1:1234/v1/models"
    },
    "litert": {
        "start": "Internal",
        "stop": "Internal",
        "check": "internal://litert"
    }
}




async def check_provider_status(url: str) -> Dict[str, Any]:
    """Check if a provider is running"""
    headers = {
        "User-Agent": "Benny/1.0",
        "Accept": "application/json"
    }
    try:
        async with httpx.AsyncClient(timeout=2.0) as client:
            resp = await client.get(url, headers=headers)
            if resp.status_code == 200:
                return {
                    "running": True,
                    "models": resp.json()
                }
            
            # Fallback for some local servers that might use different IP resolution
            if "127.0.0.1" in url:
                alt_url = url.replace("127.0.0.1", "localhost")
                resp = await client.get(alt_url, headers=headers)
                if resp.status_code == 200:
                    return {
                        "running": True,
                        "models": resp.json()
                    }
                    
        return {"running": False, "models": None, "error": f"Status {resp.status_code}" if 'resp' in locals() else "Timeout"}
    except Exception as e:
        return {"running": False, "models": None, "error": str(e)}



@router.get("/status")
async def get_all_status():
    """Get status of all local LLM providers"""
    results = {}
    
    for provider, config in SERVICE_COMMANDS.items():
        if config["check"] == "internal://litert":
            # Special case for internal library
            available = LiteRTEngine.is_available()
            
            # If internal LiteRT is missing, we report models that we can redirect to NPU
            models = [
                {
                    "id": "litert/gemma-4-E4B-it.litertlm",
                    "object": "model",
                    "owned_by": "litert-community",
                    "status": "ready" if available else "fallback"
                }
            ]
            
            if not available:
                # Add virtual NPU-optimized models that we can handle via redirection
                models.extend([
                    {"id": "litert/deepseek-r1-8b-FLM", "object": "model", "owned_by": "fallback-npu"},
                    {"id": "litert/llama3.2-1b-FLM", "object": "model", "owned_by": "fallback-npu"}
                ])

            status = {
                "running": True, # The provider is 'running' because we have a shim/fallback
                "error": None if available else "Platform Restricted (Using NPU Fallback Mode)",
                "models": {
                    "data": models
                }
            }
        else:
            status = await check_provider_status(config["check"])
            
        provider_info = LOCAL_PROVIDERS.get(provider, {})
        results[provider] = {
            **status,
            "name": provider_info.get("name", provider),
            "port": provider_info.get("port"),
            "description": provider_info.get("description", ""),
            "can_start": config["start"] is not None and config["start"] != "Internal",
            "can_stop": config["stop"] is not None and config["stop"] != "Internal"
        }
    
    return results


@router.get("/{provider}/status")
async def get_provider_status(provider: str):
    """Get status of specific provider"""
    if provider not in SERVICE_COMMANDS:
        raise HTTPException(404, f"Unknown provider: {provider}")
    
    config = SERVICE_COMMANDS[provider]
    status = await check_provider_status(config["check"])
    provider_info = LOCAL_PROVIDERS.get(provider, {})
    
    return {
        "provider": provider,
        **status,
        "name": provider_info.get("name", provider),
        "port": provider_info.get("port"),
        "description": provider_info.get("description", "")
    }


class StartResponse(BaseModel):
    status: str
    provider: str
    message: Optional[str] = None


@router.post("/{provider}/start", response_model=StartResponse)
async def start_provider(provider: str):
    """Start a local LLM provider service"""
    if provider not in SERVICE_COMMANDS:
        raise HTTPException(404, f"Unknown provider: {provider}")
    
    cmd = SERVICE_COMMANDS[provider]["start"]
    if not cmd:
        raise HTTPException(400, f"{provider} requires manual startup")
    
    try:
        # Start in new console window (Windows)
        subprocess.Popen(
            f'start "{provider}" cmd /k {cmd}',
            shell=True,
            creationflags=subprocess.CREATE_NEW_CONSOLE
        )
        
        # Wait a bit and check status
        await asyncio.sleep(2)
        status = await check_provider_status(SERVICE_COMMANDS[provider]["check"])
        
        return StartResponse(
            status="starting" if not status["running"] else "running",
            provider=provider,
            message=f"Started {provider} service"
        )
    except Exception as e:
        raise HTTPException(500, f"Failed to start {provider}: {str(e)}")


@router.post("/{provider}/stop", response_model=StartResponse)
async def stop_provider(provider: str):
    """Stop a local LLM provider service"""
    if provider not in SERVICE_COMMANDS:
        raise HTTPException(404, f"Unknown provider: {provider}")
    
    cmd = SERVICE_COMMANDS[provider]["stop"]
    if not cmd:
        raise HTTPException(400, f"{provider} requires manual shutdown")
    
    try:
        subprocess.run(cmd, shell=True, capture_output=True)
        return StartResponse(
            status="stopped",
            provider=provider,
            message=f"Stopped {provider} service"
        )
    except Exception as e:
        raise HTTPException(500, f"Failed to stop {provider}: {str(e)}")


# =============================================================================
# OLLAMA-SPECIFIC ENDPOINTS
# =============================================================================

@router.get("/ollama/models")
async def list_ollama_models():
    """List installed Ollama models"""
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get("http://localhost:11434/api/tags")
            if resp.status_code == 200:
                return resp.json()
            raise HTTPException(resp.status_code, "Failed to list models")
    except httpx.ConnectError:
        raise HTTPException(503, "Ollama not running")


class PullRequest(BaseModel):
    model: str


@router.post("/ollama/pull")
async def pull_ollama_model(request: PullRequest):
    """Pull a new model from Ollama registry"""
    try:
        async with httpx.AsyncClient(timeout=300.0) as client:
            resp = await client.post(
                "http://localhost:11434/api/pull",
                json={"name": request.model}
            )
            return {"status": "pulling", "model": request.model}
    except httpx.ConnectError:
        raise HTTPException(503, "Ollama not running")


@router.delete("/ollama/models/{model}")
async def delete_ollama_model(model: str):
    """Delete an Ollama model"""
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.delete(
                "http://localhost:11434/api/delete",
                json={"name": model}
            )
            return {"status": "deleted", "model": model}
    except httpx.ConnectError:
        raise HTTPException(503, "Ollama not running")
