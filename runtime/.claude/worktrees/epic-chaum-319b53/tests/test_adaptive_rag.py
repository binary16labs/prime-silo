"""
Test suite for Phase 1 — Adaptive RAG Pipeline.
Run with: python -m pytest tests/test_adaptive_rag.py -v
"""

import pytest
import asyncio
from unittest.mock import patch, MagicMock, AsyncMock


class TestSmartRouter:
    """Tests for the Smart Router classification node."""

    @pytest.mark.asyncio
    async def test_simple_query_routes_to_no_retrieval(self):
        from benny.core.adaptive_rag import smart_router
        state = {
            "query": "What is the capital of France?",
            "model": "Qwen3-8B-Hybrid",
            "workspace": "default",
            "execution_trace": [],
        }
        with patch("benny.core.adaptive_rag.call_model", new_callable=AsyncMock) as mock_llm:
            mock_llm.return_value = '{"route": "no_retrieval", "explanation": "Simple factual question"}'
            result = await smart_router(state)
            assert result["route"] == "no_retrieval"
            assert "smart_router" in result["execution_trace"]

    @pytest.mark.asyncio
    async def test_document_query_routes_to_single_step(self):
        from benny.core.adaptive_rag import smart_router
        state = {
            "query": "What does the Frolov report say about AI?",
            "model": "Qwen3-8B-Hybrid",
            "workspace": "default",
            "execution_trace": [],
        }
        with patch("benny.core.adaptive_rag.call_model", new_callable=AsyncMock) as mock_llm:
            mock_llm.return_value = '{"route": "single_step", "explanation": "Document lookup needed"}'
            result = await smart_router(state)
            assert result["route"] == "single_step"

    @pytest.mark.asyncio
    async def test_relational_query_routes_to_multi_hop(self):
        from benny.core.adaptive_rag import smart_router
        state = {
            "query": "How does sector X exposure affect portfolio Y based on filings?",
            "model": "Qwen3-8B-Hybrid",
            "workspace": "default",
            "execution_trace": [],
        }
        with patch("benny.core.adaptive_rag.call_model", new_callable=AsyncMock) as mock_llm:
            mock_llm.return_value = '{"route": "multi_hop", "explanation": "Cross-document reasoning required"}'
            result = await smart_router(state)
            assert result["route"] == "multi_hop"

    @pytest.mark.asyncio
    async def test_malformed_llm_response_defaults_to_single_step(self):
        from benny.core.adaptive_rag import smart_router
        state = {
            "query": "test query",
            "model": "Qwen3-8B-Hybrid",
            "workspace": "default",
            "execution_trace": [],
        }
        with patch("benny.core.adaptive_rag.call_model", new_callable=AsyncMock) as mock_llm:
            mock_llm.return_value = "I'm not sure what to do"  # Not JSON
            result = await smart_router(state)
            assert result["route"] == "single_step"


class TestDocumentGrader:
    """Tests for the document relevance grading node."""

    @pytest.mark.asyncio
    async def test_relevant_documents_kept(self):
        from benny.core.adaptive_rag import grade_documents
        state = {
            "query": "renewable energy",
            "model": "Qwen3-8B-Hybrid",
            "documents": [
                {"content": "Solar power is growing rapidly", "source": "doc1", "relevance_score": 0.0},
                {"content": "Wind turbines are efficient", "source": "doc2", "relevance_score": 0.0},
                {"content": "Cats are cute animals", "source": "doc3", "relevance_score": 0.0},
            ],
            "execution_trace": [],
        }
        with patch("benny.core.adaptive_rag.call_model", new_callable=AsyncMock) as mock_llm:
            mock_llm.side_effect = ["yes", "yes", "no"]
            result = await grade_documents(state)
            assert len(result["graded_documents"]) == 2

    @pytest.mark.asyncio
    async def test_all_irrelevant_returns_empty(self):
        from benny.core.adaptive_rag import grade_documents
        state = {
            "query": "quantum computing",
            "model": "Qwen3-8B-Hybrid",
            "documents": [
                {"content": "Cooking pasta is easy", "source": "doc1", "relevance_score": 0.0},
            ],
            "execution_trace": [],
        }
        with patch("benny.core.adaptive_rag.call_model", new_callable=AsyncMock) as mock_llm:
            mock_llm.return_value = "no"
            result = await grade_documents(state)
            assert len(result["graded_documents"]) == 0


class TestAdaptiveRAGFlow:
    """Tests for the end-to-end graph execution."""

    @pytest.mark.asyncio
    async def test_no_retrieval_flow(self):
        from benny.core.adaptive_rag import run_adaptive_rag
        
        with patch("benny.core.adaptive_rag.call_model", new_callable=AsyncMock) as mock_llm:
            # 1. smart_router
            # 2. generate_answer
            # 3. check_answer_quality
            mock_llm.side_effect = [
                '{"route": "no_retrieval", "explanation": "Simple"}',
                "The capital of France is Paris.",
                "yes"
            ]
            
            result = await run_adaptive_rag("What is the capital of France?")
            assert result["route"] == "no_retrieval"
            assert result["generation"] == "The capital of France is Paris."
            assert "smart_router" in result["execution_trace"]
            assert "generate_answer" in result["execution_trace"]
            assert "check_hallucination" not in result["execution_trace"]

    @pytest.mark.asyncio
    async def test_single_step_full_flow(self):
        from benny.core.adaptive_rag import run_adaptive_rag
        
        with patch("benny.core.adaptive_rag.get_chromadb_client") as mock_chroma, \
             patch("benny.core.adaptive_rag.call_model", new_callable=AsyncMock) as mock_llm:
            
            # Mock ChromaDB
            mock_coll = MagicMock()
            mock_coll.query.return_value = {
                "documents": [["Docling is a tool."]],
                "metadatas": [[{"source": "test.pdf"}]]
            }
            mock_chroma.return_value.get_or_create_collection.return_value = mock_coll
            
            # Mock LLM sequence: 
            # 1. router -> single_step
            # 2. grader -> yes
            # 3. generator -> answer
            # 4. hallucination -> yes
            # 5. quality -> yes
            mock_llm.side_effect = [
                '{"route": "single_step", "explanation": "Lookup"}',
                "yes",
                "Testing docling answer",
                "yes",
                "yes"
            ]
            
            result = await run_adaptive_rag("Explain docling")
            assert result["route"] == "single_step"
            assert len(result["graded_documents"]) == 1
            assert result["generation"] == "Testing docling answer"
            assert result["hallucination_check"] is True
            assert result["answer_quality"] is True

    @pytest.mark.asyncio
    async def test_retry_on_poor_quality(self):
        from benny.core.adaptive_rag import run_adaptive_rag
        
        with patch("benny.core.adaptive_rag.get_chromadb_client") as mock_chroma, \
             patch("benny.core.adaptive_rag.call_model", new_callable=AsyncMock) as mock_llm:
            
            mock_coll = MagicMock()
            mock_coll.query.return_value = {
                "documents": [["Information X"]],
                "metadatas": [[{"source": "x.md"}]]
            }
            mock_chroma.return_value.get_or_create_collection.return_value = mock_coll
            
            # 1. router -> single_step
            # 2. grader -> yes
            # 3. generator -> answer
            # 4. hallucination -> yes
            # 5. quality -> NO (triggers rewrite)
            # 6. rewriter -> new query
            # 7. (loop back to retrieval)
            # ... and then succeed
            mock_llm.side_effect = [
                '{"route": "single_step", "explanation": "Initial attempt"}', # router
                "yes", # grader
                "Poor answer", # generator
                "yes", # hallucination
                "no", # quality -> fail
                "Rewritten query", # rewriter
                "yes", # grader (2nd time)
                "Good answer", # generator (2nd time)
                "yes", # hallucination (2nd time)
                "yes" # quality (2nd time)
            ]
            
            result = await run_adaptive_rag("Bad query", max_retries=1)
            assert result["retry_count"] == 1
            assert result["generation"] == "Good answer"
            assert "rewrite_query" in result["execution_trace"]
