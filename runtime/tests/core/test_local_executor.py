import pytest
from unittest.mock import AsyncMock, patch, MagicMock
import httpx
import json
from benny.core.local_executor import resolve_executor, LemonadeExecutor, OllamaExecutor
from benny.core.models import call_model, OfflineRefusal

@pytest.mark.asyncio
async def test_resolve_executor_returns_none_for_cloud():
    """Requirement 5.3.1: anthropic/claude-* -> None."""
    assert resolve_executor("anthropic/claude-3-sonnet") is None
    assert resolve_executor("openai/gpt-4") is None

@pytest.mark.asyncio
async def test_resolve_executor_maps_each_local_prefix():
    """Requirement 5.3.2: maps lemonade/, ollama/, lmstudio/, fastflowlm/, litert/."""
    assert isinstance(resolve_executor("lemonade/model"), LemonadeExecutor)
    assert isinstance(resolve_executor("ollama/model"), OllamaExecutor)
    # litert, lmstudio, and fastflowlm should also resolve to their specific classes
    from benny.core.local_executor import LiteRTExecutor, OpenAICompatibleExecutor
    assert isinstance(resolve_executor("litert/model"), LiteRTExecutor)
    assert isinstance(resolve_executor("lmstudio/model"), OpenAICompatibleExecutor)
    assert isinstance(resolve_executor("fastflowlm/model"), OpenAICompatibleExecutor)

@pytest.mark.asyncio
async def test_lemonade_executor_generate_happy_path():
    """Requirement 5.3.3: patch httpx to return OpenAI-compatible JSON."""
    executor = LemonadeExecutor(model="test-model")
    mock_resp = MagicMock(spec=httpx.Response)
    mock_resp.status_code = 200
    mock_resp.json.return_value = {
        "choices": [{"message": {"content": "hello from lemonade"}}]
    }
    
    with patch("httpx.AsyncClient.post", new_callable=AsyncMock) as mock_post:
        mock_post.return_value = mock_resp
        result = await executor.generate("hi")
        assert result == "hello from lemonade"

@pytest.mark.asyncio
async def test_stream_yields_incremental_chunks():
    """Requirement 5.3.4: patch SSE-like body; assert async iterator yields in order."""
    executor = LemonadeExecutor(model="test-model")
    
    async def mock_aiter_lines():
        yield 'data: {"choices": [{"delta": {"content": "hello"}}]}'
        yield 'data: {"choices": [{"delta": {"content": " "}}]}'
        yield 'data: {"choices": [{"delta": {"content": "world"}}]}'
        yield 'data: [DONE]'

    mock_resp = MagicMock()
    mock_resp.aiter_lines.return_value = mock_aiter_lines()
    mock_resp.raise_for_status = MagicMock()
    
    # Simple way to patch the stream method of AsyncClient
    # Since we use: async with client.stream(...) as response:
    # client.stream(...) should return an object with __aenter__ returning the response.
    
    class MockStreamContext:
        async def __aenter__(self): return mock_resp
        async def __aexit__(self, *args): pass

    with patch("httpx.AsyncClient.stream", return_value=MockStreamContext()):
        chunks = []
        async for chunk in executor.stream("hi"):
            chunks.append(chunk)
        assert "".join(chunks) == "hello world"

@pytest.mark.asyncio
async def test_offline_still_blocks_before_executor(monkeypatch):
    """Requirement 5.3.5: BENNY_OFFLINE=1 blocks cloud models; local models use executor."""
    monkeypatch.setenv("BENNY_OFFLINE", "1")
    
    # 1. Cloud model must still raise OfflineRefusal
    with pytest.raises(OfflineRefusal):
        await call_model("openai/gpt-4", [{"role": "user", "content": "hi"}])
    
    # 2. Local model must use executor (not LiteLLM)
    mock_executor = AsyncMock()
    mock_executor.generate.return_value = "local response"
    
    # IMPORTANT: Patch where it's used (benny.core.models)
    with patch("benny.core.models.resolve_executor", return_value=mock_executor):
        # Ensure count_tokens and provider_name are present for the logger
        mock_executor.count_tokens = MagicMock(return_value=1)
        mock_executor.provider_name = "test"
        
        # Patch _run_completion to ensure it's NEVER called
        with patch("benny.core.models._run_completion") as mock_litellm:
            result = await call_model("lemonade/model", [{"role": "user", "content": "hi"}])
            assert result == "local response"
            mock_litellm.assert_not_called()

@pytest.mark.asyncio
async def test_call_model_uses_executor_for_local_model():
    """Requirement 5.3.6: end-to-end through call_model, bypass LiteLLM."""
    mock_executor = AsyncMock()
    mock_executor.generate.return_value = "direct hit"
    
    # IMPORTANT: Patch where it's used (benny.core.models)
    with patch("benny.core.models.resolve_executor", return_value=mock_executor):
        # Ensure count_tokens and provider_name are present for the logger
        mock_executor.count_tokens = MagicMock(return_value=1)
        mock_executor.provider_name = "test"
        
        with patch("benny.core.models._run_completion") as mock_litellm:
            result = await call_model("ollama/llama3", [{"role": "user", "content": "hi"}])
            assert result == "direct hit"
            # It should bypass _run_completion
            mock_litellm.assert_not_called()
