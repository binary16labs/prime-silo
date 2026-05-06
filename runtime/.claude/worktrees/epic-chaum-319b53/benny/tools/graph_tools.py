"""
Graph Tools - LangChain tools for agent access to the Synthesis Knowledge Graph.

These tools allow autonomous Benny agents in LangGraph workflows to
read from and write to the structural long-term memory.
"""

from langchain.tools import tool
from typing import Optional, List
import json

from ..core.graph_db import (
    get_full_graph, get_neighbors, get_graph_stats,
    add_triple, add_source_link, add_conflict, add_analogy,
    set_concept_embedding, vector_search
)


@tool
def query_knowledge_graph(
    workspace: str = "default",
    active_nexus_id: Optional[str] = None
) -> str:
    """
    Get the full knowledge graph for a workspace.
    Returns all concepts, sources, and relationships as structured data.
    Use this to understand what knowledge has been extracted and synthesized.
    
    Args:
        workspace: Workspace ID to query
        
    Returns:
        JSON summary of the knowledge graph (nodes and edges)
    """
    try:
        stats = get_graph_stats(workspace, run_id=active_nexus_id)
        graph = get_full_graph(workspace, run_id=active_nexus_id)
        
        # Build human-readable summary
        lines = [f"📊 Knowledge Graph: {stats['concepts']} concepts, {stats['sources']} sources, {stats['relationships']} relationships"]
        
        if stats.get("conflicts", 0) > 0:
            lines.append(f"⚠️ {stats['conflicts']} conflicts detected")
        if stats.get("analogies", 0) > 0:
            lines.append(f"🔗 {stats['analogies']} structural analogies found")
        
        lines.append("")
        
        node_map = {n["id"]: n["name"] for n in graph["nodes"]}
        for edge in graph.get("edges", [])[:30]:
            src = node_map.get(edge["source"], "?")
            tgt = node_map.get(edge["target"], "?")
            rel = edge.get("predicate", "") or edge.get("type", "")
            lines.append(f"  {src} --[{rel}]--> {tgt}")
        
        if len(graph.get("edges", [])) > 30:
            lines.append(f"  ... and {len(graph['edges']) - 30} more relationships")
        
        return "\n".join(lines)
        
    except Exception as e:
        return f"❌ Graph query error: {str(e)}"


@tool
def get_concept_neighbors(
    concept: str,
    workspace: str = "default",
    depth: int = 2,
    active_nexus_id: Optional[str] = None
) -> str:
    """
    Get the neighbourhood of a specific concept — all connected nodes
    and relationships up to N hops away.
    
    Args:
        concept: Name of the concept to explore
        workspace: Workspace ID
        depth: How many relationship hops to traverse (1-3)
        
    Returns:
        List of connected concepts and their relationships
    """
    try:
        neighbors = get_neighbors(concept, workspace, min(depth, 3), run_id=active_nexus_id)
        
        if not neighbors["nodes"]:
            return f"No neighbors found for '{concept}'"
        
        lines = [f"🔍 Neighborhood of '{concept}' (depth={depth}):"]
        node_map = {n["id"]: n["name"] for n in neighbors["nodes"]}
        
        for edge in neighbors["edges"]:
            src = node_map.get(edge["source"], "?")
            tgt = node_map.get(edge["target"], "?")
            rel = edge.get("predicate", "") or edge.get("type", "")
            lines.append(f"  {src} --[{rel}]--> {tgt}")
        
        return "\n".join(lines)
        
    except Exception as e:
        return f"❌ Neighbor query error: {str(e)}"


@tool
def add_knowledge_triple(
    subject: str,
    predicate: str,
    obj: str,
    source_name: str = "agent",
    workspace: str = "default"
) -> str:
    """
    Add a new knowledge triple to the graph.
    Use this when you discover a new relationship between concepts.
    
    Args:
        subject: The subject concept (e.g. "Dopamine")
        predicate: The relationship (e.g. "drives")
        obj: The object concept (e.g. "reward-seeking behavior")
        source_name: Source attribution (e.g. document name or "agent")
        workspace: Workspace ID
        
    Returns:
        Confirmation of the stored triple
    """
    try:
        result = add_triple(
            subject=subject,
            predicate=predicate,
            obj=obj,
            workspace=workspace,
            source_name=source_name
        )
        add_source_link(subject, source_name, workspace)
        add_source_link(obj, source_name, workspace)
        return f"✅ Stored: ({subject}) --[{predicate}]--> ({obj})"
    except Exception as e:
        return f"❌ Failed to add triple: {str(e)}"


@tool
def find_structural_analogies(
    workspace: str = "default"
) -> str:
    """
    Scan the knowledge graph for structural isomorphisms — patterns
    that repeat across different domains.
    
    This is the 'So What?' synthesis layer.
    
    Args:
        workspace: Workspace ID
        
    Returns:
        List of discovered analogies with their shared patterns
    """
    try:
        graph = get_full_graph(workspace)
        
        if not graph["nodes"]:
            return "Graph is empty. Ingest some text first."
        
        # Look for ANALOGOUS_TO edges
        node_map = {n["id"]: n["name"] for n in graph["nodes"]}
        analogies = []
        for edge in graph["edges"]:
            if edge["type"] == "ANALOGOUS_TO":
                src = node_map.get(edge["source"], "?")
                tgt = node_map.get(edge["target"], "?")
                analogies.append(f"  🔗 {src} ↔ {tgt}: {edge.get('description', '')} (Pattern: {edge.get('pattern', '')})")
        
        if analogies:
            return f"Found {len(analogies)} structural analogies:\n" + "\n".join(analogies)
        else:
            return "No structural analogies found yet. Run synthesis to discover them."
        
    except Exception as e:
        return f"❌ Analogy search error: {str(e)}"


@tool
def search_similar_concepts(
    query: str,
    workspace: str = "default",
    top_k: int = 5,
    active_nexus_id: Optional[str] = None
) -> str:
    """
    Search for concepts semantically similar to the query text
    using vector embeddings (the 'Venn' clustering layer).
    
    Args:
        query: Text to search for similar concepts
        workspace: Workspace ID
        top_k: Number of results to return
        
    Returns:
        List of similar concepts with similarity scores
    """
    try:
        # We need an embedding for the query — try local first
        from ..synthesis.engine import get_embedding
        import asyncio
        
        try:
            loop = asyncio.get_event_loop()
            if loop.is_running():
                # Can't await in sync context; use a simple fallback
                return "⚠️ Vector search requires async context. Use the API endpoint /api/graph/search instead."
        except RuntimeError:
            pass
        
        emb = asyncio.run(get_embedding(query, provider="local"))
        results = vector_search(emb, workspace, top_k, run_id=active_nexus_id)
        
        if not results:
            return "No similar concepts found. Make sure concepts have embeddings."
        
        lines = [f"🔍 Concepts similar to '{query}':"]
        for r in results:
            lines.append(f"  • {r['name']} (similarity: {r.get('score', 0):.3f})")
        
        return "\n".join(lines)
        
    except Exception as e:
        return f"❌ Similarity search error: {str(e)}"
