# Phase 1 — Adaptive RAG & Smart Router

> **Owner**: Implementation Agent  
> **PRD Reference**: `C:\Users\nsdha\OneDrive\code\benny\docs\requirements\5\PRD_dog_pound.txt`  
> **Parent Plan**: `C:\Users\nsdha\.gemini\antigravity\brain\fd945150-1e44-4e58-baa2-97d8004a2eb2\implementation_plan.md`  
> **Priority**: Foundation — critical for retrieval quality  
> **Estimated Scope**: 4 new/modified backend files, 2 modified frontend files

---

## 1. Objective

Replace the static top-k ChromaDB vector retrieval (currently in `rag_routes.py`) with an **Adaptive RAG** framework built as a LangGraph StateGraph. The pipeline must dynamically route queries through one of three retrieval strategies, apply multi-stage quality grading, and self-correct by rewriting failed queries — exactly as specified in the PRD section "The Adaptive RAG (Self-Correcting) Workflow".

---

## 2. Current State (READ THESE FILES FIRST)

Before writing any code, you MUST read and understand these existing files:

| File | Purpose | Why You Need It |
|------|---------|-----------------|
| `C:\Users\nsdha\OneDrive\code\benny\benny\api\rag_routes.py` | Current RAG endpoints (vector search, ingest) | You will ADD a new endpoint here, not replace existing ones |
| `C:\Users\nsdha\OneDrive\code\benny\benny\core\graph_db.py` | Neo4j knowledge graph operations | You will ADD multi-hop traversal methods here |
| `C:\Users\nsdha\OneDrive\code\benny\benny\graph\workflow.py` | Example of how LangGraph StateGraphs are built in this project | Follow the same patterns (imports, typing, graph construction) |
| `C:\Users\nsdha\OneDrive\code\benny\benny\core\state.py` | State schema patterns (TypedDict, Annotated reducers) | Your `AdaptiveRAGState` must follow this pattern |
| `C:\Users\nsdha\OneDrive\code\benny\benny\core\models.py` | `call_model()` function and `LOCAL_PROVIDERS` | Use `call_model()` for all LLM calls, never raw `litellm` |
| `C:\Users\nsdha\OneDrive\code\benny\benny\governance\lineage.py` | Lineage tracking functions | Call `track_workflow_start/complete` in the RAG pipeline |
| `C:\Users\nsdha\OneDrive\code\benny\frontend\src\components\Studio\nodes\DataNode.tsx` | Current data node UI | You will add `adaptive_search` operation type |
| `C:\Users\nsdha\OneDrive\code\benny\frontend\src\components\Studio\ConfigPanel.tsx` | Node configuration panel | You will add Adaptive RAG config fields |
| `C:\Users\nsdha\OneDrive\code\benny\frontend\src\constants.ts` | `API_BASE_URL` and `GOVERNANCE_HEADERS` | Use these for all fetch calls |

---

## 3. Files to Create or Modify

### 3.1 [NEW] `C:\Users\nsdha\OneDrive\code\benny\benny\core\adaptive_rag.py`

This is the core module. It implements the Adaptive RAG pipeline as a LangGraph StateGraph.

#### 3.1.1 State Definition

```python
# At the top of the file, after imports
from typing import TypedDict, Optional, List, Dict, Any, Literal
from langgraph.graph import StateGraph, START, END
from langchain_core.messages import BaseMessage

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
```

#### 3.1.2 Node Functions

You must implement exactly these node functions. Each function takes `state: AdaptiveRAGState` and returns a `dict` update.

**`smart_router(state) → dict`**
- Call `call_model()` with a system prompt that classifies the query into one of three routes
- System prompt MUST include these classification rules:
  - `no_retrieval`: Simple factual questions answerable from parametric knowledge (e.g., "What is Python?", "Define GDP")
  - `single_step`: Questions requiring document lookup but not relational reasoning (e.g., "What does the Frolov report say about AI?")
  - `multi_hop`: Questions requiring cross-document reasoning, entity relationships, or causal chains (e.g., "How would a recession in sector X affect portfolio Y based on the filings?")
- The LLM MUST respond with ONLY a JSON object: `{"route": "...", "explanation": "..."}`
- Parse the JSON. If parsing fails, default to `single_step`.
- Return: `{"route": parsed_route, "route_explanation": explanation, "execution_trace": [..., "smart_router"]}`

**`retrieve_single_step(state) → dict`**
- Use the EXISTING ChromaDB retrieval from `rag_routes.py` — import `get_chromadb_client` and query the `knowledge` collection
- Query text: use `state["rewritten_query"]` if set, otherwise `state["query"]`
- Retrieve top 10 results
- Return: `{"documents": [RetrievedDocument(...)], "execution_trace": [..., "retrieve_single_step"]}`

**`retrieve_multi_hop(state) → dict`**
- First, do the same ChromaDB retrieval as `single_step` (top 10)
- Then, call `multi_hop_traversal()` from `graph_db.py` (you will add this method — see section 3.3)
- Merge and deduplicate results, prioritizing graph results
- Return: `{"documents": merged_docs, "execution_trace": [..., "retrieve_multi_hop"]}`

**`grade_documents(state) → dict`**
- For EACH document in `state["documents"]`, call `call_model()` with a grading prompt
- Grading prompt: "You are a relevance grader. Given this document and this question, is the document relevant? Respond with ONLY 'yes' or 'no'."
- Documents graded "yes" go into `graded_documents` with `relevance_score=1.0`
- Documents graded "no" are dropped
- If ALL documents are dropped, set `graded_documents = []` (this will trigger re-write)
- Return: `{"graded_documents": [...], "execution_trace": [..., "grade_documents"]}`

**`generate_answer(state) → dict`**
- If `state["route"] == "no_retrieval"`, generate answer from parametric knowledge only (no context documents)
- Otherwise, build a context string from `graded_documents` and generate with context
- System prompt: "You are a helpful research assistant. Answer the question based STRICTLY on the provided context. If the context doesn't contain the answer, say so explicitly."
- Return: `{"generation": answer_text, "execution_trace": [..., "generate_answer"]}`

**`check_hallucination(state) → dict`**
- Call `call_model()` asking: "Is this answer fully grounded in the provided documents? Respond ONLY 'yes' or 'no'."
- Provide: the `graded_documents` as facts, and the `generation` as the answer
- Skip this check if route was `no_retrieval`
- Return: `{"hallucination_check": is_grounded, "execution_trace": [..., "check_hallucination"]}`

**`check_answer_quality(state) → dict`**
- Call `call_model()` asking: "Does this answer adequately address the original question? Is it complete and useful? Respond ONLY 'yes' or 'no'."
- Provide: the original `query` and the `generation`
- Return: `{"answer_quality": is_adequate, "execution_trace": [..., "check_answer_quality"]}`

**`rewrite_query(state) → dict`**
- Call `call_model()` asking: "The following question did not produce a satisfactory answer. Rewrite it to be more specific and searchable. Return ONLY the rewritten question, nothing else."
- Provide: the original `query`
- Increment `retry_count`
- Return: `{"rewritten_query": new_query, "retry_count": state["retry_count"] + 1, "execution_trace": [..., "rewrite_query"]}`

#### 3.1.3 Routing Functions

```python
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
```

#### 3.1.4 Graph Construction

```python
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
    # For no_retrieval route, skip hallucination check
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
```

#### 3.1.5 Required Imports (top of file)

```python
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
from ..core.graph_db import get_driver  # For multi-hop traversal
from ..core.workspace import get_workspace_path
from ..governance.lineage import track_workflow_start, track_workflow_complete

logger = logging.getLogger(__name__)
```

---

### 3.2 [MODIFY] `C:\Users\nsdha\OneDrive\code\benny\benny\api\rag_routes.py`

Add a NEW endpoint. Do NOT modify or remove any existing endpoints.

#### Add this Pydantic model (near the other models at the top):

```python
class AdaptiveRAGRequest(BaseModel):
    query: str
    workspace: str = "default"
    model: str = "Qwen3-8B-Hybrid"
    max_retries: int = 3

class AdaptiveRAGResponse(BaseModel):
    answer: Optional[str]
    route: str
    route_explanation: str
    documents_retrieved: int
    documents_relevant: int
    retry_count: int
    execution_trace: List[str]
    hallucination_check: Optional[bool]
    answer_quality: Optional[bool]
```

#### Add this endpoint (at the bottom of the file, before any final comments):

```python
@router.post("/rag/adaptive-query", response_model=AdaptiveRAGResponse)
async def adaptive_rag_query(request: AdaptiveRAGRequest):
    """
    Adaptive RAG query — self-correcting retrieval pipeline.
    Routes queries through no_retrieval / single_step / multi_hop 
    with quality grading and automatic query rewriting.
    """
    from ..core.adaptive_rag import run_adaptive_rag
    
    try:
        result = await run_adaptive_rag(
            query=request.query,
            workspace=request.workspace,
            model=request.model,
            max_retries=request.max_retries,
        )
        
        return AdaptiveRAGResponse(
            answer=result.get("generation"),
            route=result.get("route", "single_step"),
            route_explanation=result.get("route_explanation", ""),
            documents_retrieved=len(result.get("documents", [])),
            documents_relevant=len(result.get("graded_documents", [])),
            retry_count=result.get("retry_count", 0),
            execution_trace=result.get("execution_trace", []),
            hallucination_check=result.get("hallucination_check"),
            answer_quality=result.get("answer_quality"),
        )
    except Exception as e:
        raise HTTPException(500, f"Adaptive RAG failed: {str(e)}")
```

The response MUST include the header `X-RAG-Strategy` set to the route taken. Add this by using a `Response` parameter:

```python
from fastapi import Response

@router.post("/rag/adaptive-query")
async def adaptive_rag_query(request: AdaptiveRAGRequest, response: Response):
    # ... (body as above) ...
    response.headers["X-RAG-Strategy"] = result.get("route", "single_step")
    return AdaptiveRAGResponse(...)
```

---

### 3.3 [MODIFY] `C:\Users\nsdha\OneDrive\code\benny\benny\core\graph_db.py`

Add these methods to the existing module. Do NOT remove or modify existing functions.

#### Add `multi_hop_traversal()` function:

```python
def multi_hop_traversal(query: str, workspace: str = "default", depth: int = 3, limit: int = 10) -> List[Dict[str, Any]]:
    """
    Perform multi-hop graph traversal from entities mentioned in the query.
    
    Algorithm:
    1. Extract entity names from the query using simple NLP (word matching against existing nodes)
    2. For each matched entity, traverse relationships up to `depth` hops
    3. Collect connected nodes and relationship paths
    4. Return as list of {content, source, path} dicts
    
    Args:
        query: The search query
        workspace: Workspace scope
        depth: Maximum relationship hops (1-5)
        limit: Maximum results to return
    
    Returns:
        List of documents with relational context
    """
    driver = get_driver()
    if driver is None:
        return []
    
    results = []
    try:
        with driver.session() as session:
            # Step 1: Find entities mentioned in the query
            # Use a case-insensitive CONTAINS match against node names
            entity_query = """
            MATCH (n)
            WHERE any(word IN $words WHERE toLower(n.name) CONTAINS toLower(word))
            RETURN n.name AS name, labels(n) AS labels
            LIMIT 10
            """
            words = [w for w in query.split() if len(w) > 3]  # Skip short words
            if not words:
                return []
            
            entities = session.run(entity_query, words=words)
            entity_names = [record["name"] for record in entities]
            
            if not entity_names:
                return []
            
            # Step 2: Multi-hop traversal from each entity
            hop_query = f"""
            MATCH path = (start)-[*1..{min(depth, 5)}]-(connected)
            WHERE start.name IN $entity_names
            RETURN start.name AS source_entity,
                   connected.name AS connected_entity,
                   [rel IN relationships(path) | type(rel)] AS relationship_types,
                   length(path) AS hops,
                   connected.description AS description
            ORDER BY hops ASC
            LIMIT $limit
            """
            
            traversal_results = session.run(
                hop_query, 
                entity_names=entity_names, 
                limit=limit
            )
            
            for record in traversal_results:
                path_str = " → ".join(record["relationship_types"])
                content = (
                    f"Entity: {record['connected_entity']}\n"
                    f"Relationship path from {record['source_entity']}: {path_str}\n"
                    f"Hops: {record['hops']}\n"
                )
                if record.get("description"):
                    content += f"Description: {record['description']}\n"
                
                results.append({
                    "content": content,
                    "source": f"neo4j://{record['source_entity']}/{path_str}",
                    "hops": record["hops"],
                })
    except Exception as e:
        logger.warning("Multi-hop traversal failed: %s", e)
    
    return results
```

---

### 3.4 [MODIFY] `C:\Users\nsdha\OneDrive\code\benny\frontend\src\components\Studio\nodes\DataNode.tsx`

Add `adaptive_search` to the operation badge logic and output display.

Find the section that maps operation names to display labels and add:

```tsx
// In the badge/label rendering section, add this case:
case 'adaptive_search':
  return '🧠 Adaptive Search';
```

Find the operation-specific icon/color mapping and add:

```tsx
// adaptive_search should have a distinct visual treatment
'adaptive_search': { color: '#8b5cf6', icon: '🧠' }  // Purple for AI-powered search
```

---

### 3.5 [MODIFY] `C:\Users\nsdha\OneDrive\code\benny\frontend\src\components\Studio\ConfigPanel.tsx`

In the `{node.type === 'data' && (...)}` block (around line 281-311), add a new section AFTER the existing "File Path" input that renders ONLY when the operation is `adaptive_search`:

```tsx
{/* Adaptive RAG Configuration — only shown when operation is adaptive_search */}
{(node.data.config as {operation?: string})?.operation === 'adaptive_search' && (
  <>
    <div className="form-group">
      <label className="form-label" htmlFor="rag-max-retries">
        Max Retries: <strong>{(node.data.config as any)?.maxRetries || 3}</strong>
      </label>
      <input
        id="rag-max-retries"
        type="range"
        className="form-range"
        min={1}
        max={5}
        step={1}
        value={(node.data.config as any)?.maxRetries || 3}
        onChange={(e) => handleConfigChange('maxRetries', e.target.value)}
      />
    </div>
    <div className="form-group">
      <label className="form-label" htmlFor="rag-multi-hop-depth">
        Multi-Hop Depth: <strong>{(node.data.config as any)?.multiHopDepth || 3}</strong>
      </label>
      <input
        id="rag-multi-hop-depth"
        type="range"
        className="form-range"
        min={1}
        max={5}
        step={1}
        value={(node.data.config as any)?.multiHopDepth || 3}
        onChange={(e) => handleConfigChange('multiHopDepth', e.target.value)}
      />
    </div>
    <div className="form-group">
      <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
        <input
          type="checkbox"
          checked={(node.data.config as any)?.enableHallucinationCheck !== false}
          onChange={(e) => handleConfigChange('enableHallucinationCheck', e.target.checked as any)}
        />
        <span className="form-label" style={{ margin: 0 }}>Enable Hallucination Grading</span>
      </label>
    </div>
  </>
)}
```

Also add `adaptive_search` to the data operation `<select>` options:

```tsx
<option value="adaptive_search">Adaptive RAG Search (AI-Powered)</option>
```

### 3.6 [MODIFY] `C:\Users\nsdha\OneDrive\code\benny\benny\api\studio_executor.py`

In the `execute_data_node` function, add a handler for the `adaptive_search` operation. Add this BEFORE the final `return {"error": f"Unknown data operation: {operation}"}`:

```python
elif operation == "adaptive_search":
    from ..core.adaptive_rag import run_adaptive_rag
    
    query = context.get("message", "")
    max_retries = int(config.get("maxRetries", 3))
    
    try:
        result = await run_adaptive_rag(
            query=query,
            workspace=workspace,
            model=config.get("model", "Qwen3-8B-Hybrid"),
            max_retries=max_retries,
        )
        
        answer = result.get("generation", "")
        context_text = ""
        for doc in result.get("graded_documents", []):
            context_text += f"[Source: {doc.get('source', 'Unknown')}]\n{doc.get('content', '')}\n\n"
        
        return {
            "results": result.get("graded_documents", []),
            "context_text": context_text,
            "answer": answer,
            "route": result.get("route", "single_step"),
            "retry_count": result.get("retry_count", 0),
            "count": len(result.get("graded_documents", [])),
        }
    except Exception as e:
        return {"error": str(e), "results": []}
```

---

## 4. Behaviour-Driven Development (BDD) Acceptance Criteria

### Feature: Smart Router Classification

```gherkin
Feature: Smart Router correctly classifies query complexity

  Scenario: Simple factual query routes to no_retrieval
    Given the Adaptive RAG pipeline is initialized
    When I submit the query "What is the capital of France?"
    Then the route should be "no_retrieval"
    And no documents should be retrieved
    And the generation should contain "Paris"
    And the execution_trace should contain "smart_router" and "generate_answer"
    And the execution_trace should NOT contain "retrieve_single_step" or "retrieve_multi_hop"

  Scenario: Document lookup query routes to single_step
    Given the workspace "test_ws" has documents ingested into ChromaDB
    When I submit the query "What does the Frolov report say about AI regulation?"
    Then the route should be "single_step"
    And documents should be retrieved from ChromaDB
    And the documents should be graded for relevance
    And the execution_trace should contain "retrieve_single_step" and "grade_documents"

  Scenario: Complex relational query routes to multi_hop
    Given the workspace "test_ws" has entities in Neo4j
    When I submit the query "How would a recession in the technology sector affect Portfolio Alpha based on the SEC filings?"
    Then the route should be "multi_hop"
    And documents should be retrieved from BOTH ChromaDB AND Neo4j
    And the execution_trace should contain "retrieve_multi_hop"
```

### Feature: Document Relevance Grading

```gherkin
Feature: Retrieved documents are graded for relevance

  Scenario: Relevant documents are kept, irrelevant are dropped
    Given 5 documents are retrieved for the query "renewable energy policy"
    And 3 of them discuss renewable energy
    And 2 of them discuss unrelated topics
    When the grader runs
    Then graded_documents should contain exactly 3 documents
    And each graded document should have relevance_score of 1.0

  Scenario: All documents irrelevant triggers rewrite
    Given 5 documents are retrieved for the query "quantum computing regulations"
    And none of them are relevant
    When the grader runs
    Then graded_documents should be empty
    And the pipeline should route to "rewrite_query"
    And retry_count should increment by 1
```

### Feature: Hallucination Detection

```gherkin
Feature: Generated answers are checked for hallucination

  Scenario: Grounded answer passes hallucination check
    Given the graded documents contain "Revenue increased by 15% in Q3"
    And the generated answer says "Revenue grew by 15% in the third quarter"
    When the hallucination checker runs
    Then hallucination_check should be true

  Scenario: Hallucinated answer triggers rewrite
    Given the graded documents contain "Revenue increased by 15% in Q3"  
    And the generated answer says "Revenue decreased by 30% in Q3"
    When the hallucination checker runs
    Then hallucination_check should be false
    And the pipeline should route to "rewrite_query" if retries remain
```

### Feature: Self-Correcting Query Rewrite

```gherkin
Feature: Failed queries are automatically rewritten and retried

  Scenario: Query is rewritten after poor answer quality
    Given the original query "AI stuff" produces a low-quality answer
    And max_retries is set to 3
    When the answer quality check fails
    Then the query should be rewritten to something more specific
    And retrieval should be attempted again with the rewritten query
    And retry_count should be 1

  Scenario: Max retries prevents infinite loops
    Given a query that consistently produces poor results
    And max_retries is set to 2
    When the pipeline has retried 2 times
    Then the pipeline should return the best available answer
    And retry_count should be 2
    And the pipeline should reach END without another rewrite
```

### Feature: Adaptive RAG API Endpoint

```gherkin
Feature: POST /api/rag/adaptive-query endpoint

  Scenario: Successful adaptive query
    Given the API server is running
    When I POST to "/api/rag/adaptive-query" with:
      | field       | value                          |
      | query       | What is described in document1? |
      | workspace   | default                        |
      | model       | Qwen3-8B-Hybrid                |
      | max_retries | 3                              |
    Then the response status should be 200
    And the response should contain "answer" field
    And the response should contain "route" field
    And the response should contain "execution_trace" array
    And the response header "X-RAG-Strategy" should be set

  Scenario: Empty query returns error
    When I POST to "/api/rag/adaptive-query" with an empty query
    Then the response status should be 422 or 500
```

---

## 5. Test-Driven Development (TDD) Test File

### Create: `C:\Users\nsdha\OneDrive\code\benny\tests\test_adaptive_rag.py`

```python
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
                {"content": "Recipe for pasta", "source": "doc1", "relevance_score": 0.0},
            ],
            "execution_trace": [],
        }
        with patch("benny.core.adaptive_rag.call_model", new_callable=AsyncMock) as mock_llm:
            mock_llm.return_value = "no"
            result = await grade_documents(state)
            assert len(result["graded_documents"]) == 0


class TestHallucinationGrader:
    """Tests for the hallucination detection node."""

    @pytest.mark.asyncio
    async def test_grounded_answer_passes(self):
        from benny.core.adaptive_rag import check_hallucination
        state = {
            "query": "What was the revenue?",
            "model": "Qwen3-8B-Hybrid",
            "route": "single_step",
            "graded_documents": [{"content": "Revenue was $10M", "source": "doc1", "relevance_score": 1.0}],
            "generation": "The revenue was $10 million.",
            "execution_trace": [],
        }
        with patch("benny.core.adaptive_rag.call_model", new_callable=AsyncMock) as mock_llm:
            mock_llm.return_value = "yes"
            result = await check_hallucination(state)
            assert result["hallucination_check"] is True

    @pytest.mark.asyncio
    async def test_no_retrieval_skips_check(self):
        from benny.core.adaptive_rag import check_hallucination
        state = {
            "query": "What is Python?",
            "model": "Qwen3-8B-Hybrid",
            "route": "no_retrieval",
            "graded_documents": [],
            "generation": "Python is a programming language.",
            "execution_trace": [],
        }
        # Should skip the check entirely
        result = await check_hallucination(state)
        assert result.get("hallucination_check") is None or result.get("hallucination_check") is True


class TestRoutingFunctions:
    """Tests for the conditional routing logic."""

    def test_route_query_no_retrieval(self):
        from benny.core.adaptive_rag import route_query
        assert route_query({"route": "no_retrieval"}) == "generate_answer"

    def test_route_query_single_step(self):
        from benny.core.adaptive_rag import route_query
        assert route_query({"route": "single_step"}) == "retrieve_single_step"

    def test_route_query_multi_hop(self):
        from benny.core.adaptive_rag import route_query
        assert route_query({"route": "multi_hop"}) == "retrieve_multi_hop"

    def test_after_grading_empty_triggers_rewrite(self):
        from benny.core.adaptive_rag import after_grading
        state = {"graded_documents": [], "retry_count": 0, "max_retries": 3}
        assert after_grading(state) == "rewrite_query"

    def test_after_grading_with_docs_generates(self):
        from benny.core.adaptive_rag import after_grading
        state = {"graded_documents": [{"content": "x"}], "retry_count": 0, "max_retries": 3}
        assert after_grading(state) == "generate_answer"

    def test_after_grading_max_retries_forces_generate(self):
        from benny.core.adaptive_rag import after_grading
        state = {"graded_documents": [], "retry_count": 3, "max_retries": 3}
        assert after_grading(state) == "generate_answer"

    def test_after_answer_quality_good_ends(self):
        from benny.core.adaptive_rag import after_answer_quality
        state = {"answer_quality": True, "retry_count": 0, "max_retries": 3}
        assert after_answer_quality(state) == "__end__"

    def test_after_answer_quality_bad_rewrites(self):
        from benny.core.adaptive_rag import after_answer_quality
        state = {"answer_quality": False, "retry_count": 0, "max_retries": 3}
        assert after_answer_quality(state) == "rewrite_query"


class TestGraphConstruction:
    """Tests for the graph building and execution."""

    def test_graph_compiles(self):
        from benny.core.adaptive_rag import build_adaptive_rag_graph
        graph = build_adaptive_rag_graph()
        assert graph is not None

    @pytest.mark.asyncio
    async def test_full_pipeline_no_retrieval(self):
        from benny.core.adaptive_rag import run_adaptive_rag
        with patch("benny.core.adaptive_rag.call_model", new_callable=AsyncMock) as mock_llm:
            mock_llm.side_effect = [
                '{"route": "no_retrieval", "explanation": "Simple question"}',  # router
                "Paris is the capital of France.",  # generate
                "yes",  # answer quality
            ]
            result = await run_adaptive_rag("What is the capital of France?", "default", "test-model")
            assert result["route"] == "no_retrieval"
            assert result["generation"] is not None
            assert "smart_router" in result["execution_trace"]
            assert "generate_answer" in result["execution_trace"]


class TestMultiHopTraversal:
    """Tests for the Neo4j multi-hop traversal."""

    def test_multi_hop_returns_empty_when_no_driver(self):
        from benny.core.graph_db import multi_hop_traversal
        with patch("benny.core.graph_db.get_driver", return_value=None):
            results = multi_hop_traversal("test query")
            assert results == []

    def test_multi_hop_skips_short_words(self):
        from benny.core.graph_db import multi_hop_traversal
        with patch("benny.core.graph_db.get_driver", return_value=None):
            # All words are 3 chars or less, should return empty
            results = multi_hop_traversal("a is of")
            assert results == []
```

---

## 6. Execution Order

1. Read ALL files listed in Section 2
2. Create `C:\Users\nsdha\OneDrive\code\benny\tests\test_adaptive_rag.py` (tests first — TDD)
3. Create `C:\Users\nsdha\OneDrive\code\benny\benny\core\adaptive_rag.py`
4. Modify `C:\Users\nsdha\OneDrive\code\benny\benny\core\graph_db.py` — add `multi_hop_traversal()`
5. Modify `C:\Users\nsdha\OneDrive\code\benny\benny\api\rag_routes.py` — add endpoint
6. Modify `C:\Users\nsdha\OneDrive\code\benny\benny\api\studio_executor.py` — add `adaptive_search` handler
7. Modify `C:\Users\nsdha\OneDrive\code\benny\frontend\src\components\Studio\nodes\DataNode.tsx`
8. Modify `C:\Users\nsdha\OneDrive\code\benny\frontend\src\components\Studio\ConfigPanel.tsx`
9. Run tests: `cd C:\Users\nsdha\OneDrive\code\benny && python -m pytest tests/test_adaptive_rag.py -v`
10. Start backend: `cd C:\Users\nsdha\OneDrive\code\benny && python -m uvicorn benny.api.server:app --port 8005 --reload`
11. Verify endpoint: `curl -X POST http://localhost:8005/api/rag/adaptive-query -H "Content-Type: application/json" -H "X-Benny-API-Key: benny-mesh-2026-auth" -d '{"query": "What is Python?", "workspace": "default"}'`

---

## 7. Definition of Done

- [ ] All 8 unit tests in `test_adaptive_rag.py` pass
- [ ] `POST /api/rag/adaptive-query` returns 200 with correct response schema
- [ ] `X-RAG-Strategy` response header is present
- [ ] Existing `POST /api/rag/query` endpoint still works (regression check)
- [ ] Data node in Studio shows `Adaptive RAG Search` option
- [ ] ConfigPanel shows max_retries slider and hallucination toggle when `adaptive_search` is selected
- [ ] No new linting errors in either Python or TypeScript
