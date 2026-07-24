"""T4 — the ADR-004 judge must work across providers. LM Studio rejects
response_format:json_object (HTTP 400); the judge retries WITHOUT it and still scores."""

import httpx
import pytest

import benny.core.local_executor as le
from benny.core.offload import gate as gate_mod
from benny.core.offload.manifest import from_dict


def _manifest():
    return from_dict(
        {
            "format": "aamp.offload_task/1",
            "id": "judge-compat",
            "intent": "define add(a,b)",
            "risk_tier": "yellow",
            "executor": {"mode": "generate", "model": "house/x"},
            "acceptance_criteria": [{"id": "ac1", "statement": "defines add(a,b) returning a+b"}],
        }
    )


class _LMStudioLikeExecutor:
    """Rejects response_format:json_object (like LM Studio), succeeds without it."""

    def __init__(self):
        self.calls = []

    async def generate(self, prompt, system=None, extra_body=None, **kw):
        self.calls.append(extra_body or {})
        if extra_body and "response_format" in extra_body:
            raise httpx.HTTPStatusError(
                "400", request=httpx.Request("POST", "http://x"),
                response=httpx.Response(400, text="'response_format.type' must be 'json_schema' or 'text'"),
            )
        return '{"score": 1.0, "rationale": "defines add correctly", "unmet": []}'


@pytest.mark.asyncio
async def test_judge_retries_without_response_format(monkeypatch):
    exe = _LMStudioLikeExecutor()
    monkeypatch.setattr(le, "resolve_executor", lambda m: exe)
    result = await gate_mod.run_judge(_manifest(), "def add(a,b):\n    return a+b", "lmstudio/judge")
    assert result["available"] is True
    assert result["score"] == 1.0
    # attempt 0 sent response_format (lemonade-optimal), attempt 1 dropped it (LM Studio-safe)
    assert "response_format" in exe.calls[0]
    assert "response_format" not in exe.calls[1]


class _AlwaysDown:
    async def generate(self, *a, **k):
        raise httpx.ConnectError("connection refused")


@pytest.mark.asyncio
async def test_judge_unavailable_stays_honest(monkeypatch):
    monkeypatch.setattr(le, "resolve_executor", lambda m: _AlwaysDown())
    result = await gate_mod.run_judge(_manifest(), "artifact", "lmstudio/judge")
    # both attempts raise -> honest None, never a fabricated pass
    assert result["score"] is None
    assert result["available"] is True
