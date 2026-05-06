"""
Adaptive RAG Pipeline — Self-correcting retrieval with Smart Router.

Architecture:
  START → SmartRouter → [NoRetrieval | SingleStep | MultiHop] → 
  GradeDocuments → GenerateAnswer → HallucinationGrader → 
  AnswerGrader → [END | RewriteQuery → loop back]
"""

from __future__ import annotations

import logging
import json
from typing import TypedDict, Optional, List, Dict, Any, Literal

from langgraph.graph import StateGraph, START, END

from ..core.models import call_model
from ..core.graph_db import get_driver, multi_hop_traversal  # For multi-hop traversal
from ..core.workspace import get_workspace_path
from ..governance.lineage import track_workflow_start, track_workflow_complete
from ..tools.knowledge import get_chromadb_client

logger = logging.getLogger(__name__)

# =============================================================================
# STATE DEFINITION
# =============================================================================

class RetrievedDocument(TypedDict):
    """A single retrieved document with metadata."""
    content: str
    source: str
    relevance_score: float  # 0.0 to 1.0, set by RetrieverGrader

class AdaptiveRAGState(TypedDict):
    """State schema for the Adaptive RAG pipeline."""
    # Input
    query: str                          # Original user query
    workspace: str                      # Workspace for ChromaDB/Neo4j scoping
    model: str                          # LLM model identifier (passed to call_model)
    
    # Routing
    route: Literal["no_retrieval", "single_step", "multi_hop"]  # Smart Router decision
    
    # Retrieval
    documents: List[RetrievedDocument]   # Raw retrieved documents
    graded_documents: List[RetrievedDocument]  # Documents that passed relevance grading
    
    # Generation
    generation: Optional[str]           # Generated answer
    
    # Quality Control
    hallucination_check: Optional[bool]  # True = grounded, False = hallucinated
    answer_quality: Optional[bool]       # True = adequate, False = needs improvement
    
    # Self-Correction
    rewritten_query: Optional[str]       # Refined query for retry
    retry_count: int                     # Current retry iteration
    max_retries: int                     # Maximum retries (default 3)
    
    # Metadata
    route_explanation: str               # Why the router chose this route
    execution_trace: List[str]           # Ordered list of nodes executed


# =============================================================================
# NODE FUNCTIONS
# =============================================================================

async def smart_router(state: AdaptiveRAGState) -> dict:
    """Classify the query into no_retrieval, single_step, or multi_hop."""
    logger.info("--- NODE: smart_router ---")
    
    system_prompt = """You are a smart router for a RAG pipeline.
Your goal is to classify a user query into one of three routes based on its complexity:

1. `no_retrieval`: Simple factual questions or greetings that can be answered from your internal knowledge.
   Example: "What is the capital of France?", "Hi", "Define GDP".
2. `single_step`: Questions requiring a simple document lookup but not complex relational reasoning.
   Example: "What does the Frolov report say about AI?", "Who is the CEO of Company X?".
3. `multi_hop`: Questions requiring cross-document reasoning, entity relationships, or causal chains.
   Example: "How would a recession in sector X affect portfolio Y based on the filings?".

Respond ONLY with a JSON object: {"route": "no_retrieval" | "single_step" | "multi_hop", "explanation": "Brief reasoning"}"""

    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": state["query"]}
    ]
    
    try:
        response = await call_model(model=state["model"], messages=messages, temperature=0.0)
        # Handle cases where response might be wrapped in ```json ... ```
        clean_response = response.strip()
        if clean_response.startswith("```json"):
            clean_response = clean_response[7:-3].strip()
        elif clean_response.startswith("```"):
            clean_response = clean_response[3:-3].strip()
            
        parsed = json.loads(clean_response)
        route = parsed.get("route", "single_step")
        explanation = parsed.get("explanation", "")
    except Exception as e:
        logger.warning(f"Router failed to parse LLM response: {e}. Response: {response}")
        route = "single_step"
        explanation = "Defaulted to single_step due to parsing error"

    return {
        "route": route, 
        "route_explanation": explanation, 
        "execution_trace": state.get("execution_trace", []) + ["smart_router"]
    }


async def retrieve_single_step(state: AdaptiveRAGState) -> dict:
    """Retrieve documents from ChromaDB."""
    logger.info("--- NODE: retrieve_single_step ---")
    
    query = state.get("rewritten_query") or state["query"]
    workspace = state["workspace"]
    
    try:
        client = get_chromadb_client(workspace)
        collection = client.get_or_create_collection("knowledge")
        
        results = collection.query(
            query_texts=[query],
            n_results=10
        )
        
        documents = []
        if results and results["documents"] and results["documents"][0]:
            for doc, meta in zip(results["documents"][0], results["metadatas"][0]):
                documents.append({
                    "content": doc,
                    "source": meta.get("source", "Unknown"),
                    "relevance_score": 0.0
                })
        
        return {
            "documents": documents,
            "execution_trace": state.get("execution_trace", []) + ["retrieve_single_step"]
        }
    except Exception as e:
        logger.error(f"Retrieval failed: {e}")
        return {
            "documents": [],
            "execution_trace": state.get("execution_trace", []) + ["retrieve_single_step"]
        }


async def retrieve_multi_hop(state: AdaptiveRAGState) -> dict:
    """Retrieve from ChromaDB and perform multi-hop graph traversal."""
    logger.info("--- NODE: retrieve_multi_hop ---")
    
    query = state.get("rewritten_query") or state["query"]
    workspace = state["workspace"]
    
    # 1. ChromaDB Retrieval
    chroma_docs = []
    try:
        client = get_chromadb_client(workspace)
        collection = client.get_or_create_collection("knowledge")
        results = collection.query(query_texts=[query], n_results=10)
        if results and results["documents"] and results["documents"][0]:
            for doc, meta in zip(results["documents"][0], results["metadatas"][0]):
                chroma_docs.append({
                    "content": doc,
                    "source": meta.get("source", "Unknown"),
                    "relevance_score": 0.0
                })
    except Exception as e:
        logger.error(f"ChromaDB retrieval failed in multi-hop: {e}")

    # 2. Neo4j Multi-Hop Traversal
    graph_docs = multi_hop_traversal(query, workspace=workspace)
    formatted_graph_docs = []
    for gdoc in graph_docs:
        formatted_graph_docs.append({
            "content": gdoc["content"],
            "source": gdoc["source"],
            "relevance_score": 0.0
        })

    # Merge and deduplicate (by source/content simplified)
    merged = chroma_docs + formatted_graph_docs
    seen = set()
    deduped = []
    for d in merged:
        if d["content"] not in seen:
            deduped.append(d)
            seen.add(d["content"])

    return {
        "documents": deduped,
        "execution_trace": state.get("execution_trace", []) + ["retrieve_multi_hop"]
    }


async def grade_documents(state: AdaptiveRAGState) -> dict:
    """Grade documents for relevance."""
    logger.info("--- NODE: grade_documents ---")
    
    query = state.get("rewritten_query") or state["query"]
    documents = state["documents"]
    graded_documents = []
    
    for doc in documents:
        system_prompt = """You are a relevance grader. Given a document and a user question, evaluate if the document is relevant to answering the question.
Respond with ONLY 'yes' or 'no'."""
        
        user_prompt = f"Question: {query}\n\nDocument: {doc['content']}"
        
        try:
            response = await call_model(model=state["model"], messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt}
            ], temperature=0.0)
            
            if "yes" in response.lower():
                doc["relevance_score"] = 1.0
                graded_documents.append(doc)
        except Exception as e:
            logger.warning(f"Grading failed for doc: {e}")

    return {
        "graded_documents": graded_documents,
        "execution_trace": state.get("execution_trace", []) + ["grade_documents"]
    }


async def generate_answer(state: AdaptiveRAGState) -> dict:
    """Generate the answer based on context or parametric knowledge."""
    logger.info("--- NODE: generate_answer ---")
    
    query = state.get("rewritten_query") or state["query"]
    route = state["route"]
    graded_docs = state["graded_documents"]
    
    if route == "no_retrieval":
        system_prompt = "You are a helpful research assistant. Answer the question accurately based on your knowledge."
        context_str = "No external context used."
    else:
        system_prompt = """You are a helpful research assistant. Answer the question based STRICTLY on the provided context. 
If the context doesn't contain the answer, say so explicitly."""
        context_str = "\n".join([f"[Source: {d['source']}]\n{d['content']}" for d in graded_docs])

    user_prompt = f"CONTEXT:\n{context_str}\n\nQUESTION: {query}"
    
    try:
        generation = await call_model(model=state["model"], messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt}
        ])
        
        return {
            "generation": generation,
            "execution_trace": state.get("execution_trace", []) + ["generate_answer"]
        }
    except Exception as e:
        logger.error(f"Generation failed: {e}")
        return {
            "generation": f"Error generating answer: {str(e)}",
            "execution_trace": state.get("execution_trace", []) + ["generate_answer"]
        }


async def check_hallucination(state: AdaptiveRAGState) -> dict:
    """Check if the answer is grounded in the documents."""
    logger.info("--- NODE: check_hallucination ---")
    
    if state["route"] == "no_retrieval":
        return {"hallucination_check": True, "execution_trace": state.get("execution_trace", []) + ["check_hallucination"]}
    
    graded_docs = state["graded_documents"]
    generation = state["generation"]
    
    context_str = "\n".join([d['content'] for d in graded_docs])
    
    system_prompt = """You are a hallucination grader. evaluate if the generated answer is fully grounded in the provided facts.
Respond with ONLY 'yes' if it is grounded, or 'no' if it contains hallucinations or unverified info."""
    
    user_prompt = f"FACTS:\n{context_str}\n\nANSWER:\n{generation}"
    
    try:
        response = await call_model(model=state["model"], messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt}
        ], temperature=0.0)
        
        is_grounded = "yes" in response.lower()
        return {
            "hallucination_check": is_grounded,
            "execution_trace": state.get("execution_trace", []) + ["check_hallucination"]
        }
    except Exception as e:
        logger.warning(f"Hallucination check failed: {e}")
        return {"hallucination_check": True} # Default to true on error to avoid loops


async def check_answer_quality(state: AdaptiveRAGState) -> dict:
    """Check if the answer addresses the user query."""
    logger.info("--- NODE: check_answer_quality ---")
    
    query = state["query"]
    generation = state["generation"]
    
    system_prompt = """You are a quality grader. Does the following answer adequately address the original question? Is it complete and useful? 
Respond with ONLY 'yes' or 'no'."""
    
    user_prompt = f"QUESTION: {query}\n\nANSWER: {generation}"
    
    try:
        response = await call_model(model=state["model"], messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt}
        ], temperature=0.0)
        
        is_adequate = "yes" in response.lower()
        return {
            "answer_quality": is_adequate,
            "execution_trace": state.get("execution_trace", []) + ["check_answer_quality"]
        }
    except Exception as e:
        logger.warning(f"Quality check failed: {e}")
        return {"answer_quality": True}


async def rewrite_query(state: AdaptiveRAGState) -> dict:
    """Rewrite the query for better retrieval."""
    logger.info("--- NODE: rewrite_query ---")
    
    query = state["query"]
    
    system_prompt = """The following question did not produce a satisfactory answer. 
Rewrite it to be more specific and searchable for a vector database. 
Return ONLY the rewritten question, nothing else."""
    
    try:
        new_query = await call_model(model=state["model"], messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": query}
        ])
        
        return {
            "rewritten_query": new_query.strip(),
            "retry_count": state["retry_count"] + 1,
            "execution_trace": state.get("execution_trace", []) + ["rewrite_query"]
        }
    except Exception as e:
        logger.warning(f"Query rewrite failed: {e}")
        return {
            "retry_count": state["retry_count"] + 1,
            "execution_trace": state.get("execution_trace", []) + ["rewrite_query"]
        }


# =============================================================================
# ROUTING FUNCTIONS
# =============================================================================

def route_query(state: AdaptiveRAGState) -> Literal["generate_answer", "retrieve_single_step", "retrieve_multi_hop"]:
    """Route after smart_router based on the classified route."""
    route = state.get("route", "single_step")
    if route == "no_retrieval":
        return "generate_answer"
    elif route == "multi_hop":
        return "retrieve_multi_hop"
    else:
        return "retrieve_single_step"

def after_grading(state: AdaptiveRAGState) -> Literal["generate_answer", "rewrite_query"]:
    """After grading, decide: generate or rewrite."""
    graded = state.get("graded_documents", [])
    if len(graded) == 0 and state.get("retry_count", 0) < state.get("max_retries", 3):
        return "rewrite_query"
    return "generate_answer"

def after_hallucination_check(state: AdaptiveRAGState) -> Literal["check_answer_quality", "rewrite_query"]:
    """After hallucination check: if hallucinated and retries left, rewrite."""
    if not state.get("hallucination_check", True) and state.get("retry_count", 0) < state.get("max_retries", 3):
        return "rewrite_query"
    return "check_answer_quality"

def after_answer_quality(state: AdaptiveRAGState) -> Literal["__end__", "rewrite_query"]:
    """After answer quality check: if poor and retries left, rewrite."""
    if not state.get("answer_quality", True) and state.get("retry_count", 0) < state.get("max_retries", 3):
        return "rewrite_query"
    return "__end__"

def after_rewrite(state: AdaptiveRAGState) -> Literal["retrieve_single_step", "retrieve_multi_hop"]:
    """After rewrite, go back to retrieval using the original route."""
    route = state.get("route", "single_step")
    if route == "multi_hop":
        return "retrieve_multi_hop"
    return "retrieve_single_step"


# =============================================================================
# GRAPH CONSTRUCTION
# =============================================================================

def build_adaptive_rag_graph() -> StateGraph:
    """Build the Adaptive RAG LangGraph."""
    graph = StateGraph(AdaptiveRAGState)
    
    # Add nodes
    graph.add_node("smart_router", smart_router)
    graph.add_node("retrieve_single_step", retrieve_single_step)
    graph.add_node("retrieve_multi_hop", retrieve_multi_hop)
    graph.add_node("grade_documents", grade_documents)
    graph.add_node("generate_answer", generate_answer)
    graph.add_node("check_hallucination", check_hallucination)
    graph.add_node("check_answer_quality", check_answer_quality)
    graph.add_node("rewrite_query", rewrite_query)
    
    # Edges
    graph.add_edge(START, "smart_router")
    graph.add_conditional_edges("smart_router", route_query, {
        "generate_answer": "generate_answer",
        "retrieve_single_step": "retrieve_single_step",
        "retrieve_multi_hop": "retrieve_multi_hop",
    })
    graph.add_edge("retrieve_single_step", "grade_documents")
    graph.add_edge("retrieve_multi_hop", "grade_documents")
    graph.add_conditional_edges("grade_documents", after_grading, {
        "generate_answer": "generate_answer",
        "rewrite_query": "rewrite_query",
    })
    
    # For generate_answer, skip hallucination check if no_retrieval
    graph.add_conditional_edges("generate_answer", lambda s: "check_answer_quality" if s["route"] == "no_retrieval" else "check_hallucination", {
        "check_hallucination": "check_hallucination",
        "check_answer_quality": "check_answer_quality",
    })
    
    graph.add_conditional_edges("check_hallucination", after_hallucination_check, {
        "check_answer_quality": "check_answer_quality",
        "rewrite_query": "rewrite_query",
    })
    
    graph.add_conditional_edges("check_answer_quality", after_answer_quality, {
        "__end__": END,
        "rewrite_query": "rewrite_query",
    })
    
    graph.add_conditional_edges("rewrite_query", after_rewrite, {
        "retrieve_single_step": "retrieve_single_step",
        "retrieve_multi_hop": "retrieve_multi_hop",
    })
    
    return graph.compile()


async def run_adaptive_rag(
    query: str,
    workspace: str = "default",
    model: str = "Qwen3-8B-Hybrid",
    max_retries: int = 3
) -> AdaptiveRAGState:
    """Execute the Adaptive RAG pipeline."""
    graph = build_adaptive_rag_graph()
    
    initial_state: AdaptiveRAGState = {
        "query": query,
        "workspace": workspace,
        "model": model,
        "route": "single_step",  # Will be overwritten by smart_router
        "documents": [],
        "graded_documents": [],
        "generation": None,
        "hallucination_check": None,
        "answer_quality": None,
        "rewritten_query": None,
        "retry_count": 0,
        "max_retries": max_retries,
        "route_explanation": "",
        "execution_trace": [],
    }
    
    result = await graph.ainvoke(initial_state)
    return result
