"""A9 — server-side call-deadline audit (2026-07-06 frozen-synthesis incident).

The reproduction: a deep-synthesis ingest froze at file 21/40 for >30 minutes
with zero lemonade traffic and zero retry log entries — some awaited step in
the per-file synthesis path has no deadline (executor timeout=900s never
fired, local-embedding httpx timeout=300s never fired). The contract:

  **a task may fail, but may never freeze.**

Await inventory of the deep-synthesis per-file path (rag_routes.py):
  - parallel_extract_triples(timeout=300)  — inner timeout param
  - save_knowledge_triples                 — Neo4j writes, NO deadline
  - call_llm (wiki summary)                — executor 900s + silent retries
  - save_concept_article                   — file IO
  - _get_openai_embedding                  — openai client DEFAULT 600s × retries
The fix is categorical, not per-suspect: `run_with_deadline` wraps the WHOLE
per-file synthesis step, so any hung inner await fails that file within the
deadline and the task record keeps advancing.
"""

from __future__ import annotations

import asyncio

import pytest

from benny.synthesis import engine


@pytest.mark.asyncio
async def test_run_with_deadline_returns_result() -> None:
    async def quick():
        return "done"

    assert await engine.run_with_deadline(quick(), 5.0, "quick op") == "done"


@pytest.mark.asyncio
async def test_run_with_deadline_fails_a_hung_await_in_bounded_time() -> None:
    """The 2026-07-06 reproduction: an await that never resolves must raise
    within the deadline — never freeze the task mid-file."""

    async def hung():
        await asyncio.sleep(3600)

    with pytest.raises(TimeoutError) as exc:
        await engine.run_with_deadline(hung(), 0.2, "deep synthesis of card_21.md")
    # honest error: names the step and the deadline (goes into the AER entry)
    assert "card_21.md" in str(exc.value)
    assert "deadline" in str(exc.value)


@pytest.mark.asyncio
async def test_openai_embedding_client_has_explicit_timeout_and_bounded_retries(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The openai SDK defaults to 600s timeout x silent retries (>=30 min of
    invisible hang). The embedding client must pin both explicitly."""
    captured: dict = {}

    class _FakeEmbeddings:
        async def create(self, **kwargs):
            class _D:
                embedding = [0.0] * 8

            class _R:
                data = [_D()]

            return _R()

    class _FakeClient:
        def __init__(self, **kwargs):
            captured.update(kwargs)
            self.embeddings = _FakeEmbeddings()

    import openai

    monkeypatch.setattr(openai, "AsyncOpenAI", _FakeClient)
    await engine._get_openai_embedding("hello")
    assert "timeout" in captured and captured["timeout"] is not None
    assert "max_retries" in captured and captured["max_retries"] <= 1
