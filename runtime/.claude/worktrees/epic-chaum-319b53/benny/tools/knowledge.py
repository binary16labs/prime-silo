"""
Knowledge Tools - ChromaDB-based semantic search capabilities
"""

from langchain.tools import tool
from typing import Optional, List
import chromadb
from chromadb.config import Settings

from ..core.workspace import get_workspace_path, smart_output


def get_chromadb_client(workspace_id: str = "default") -> chromadb.PersistentClient:
    """Get ChromaDB client for workspace"""
    chromadb_path = get_workspace_path(workspace_id, "chromadb")
    chromadb_path.mkdir(parents=True, exist_ok=True)
    return chromadb.PersistentClient(
        path=str(chromadb_path),
        settings=Settings(anonymized_telemetry=False)
    )


@tool
def search_knowledge_workspace(
    query: str,
    workspace: str = "default",
    top_k: int = 20,
    active_nexus_id: Optional[str] = None
) -> str:
    """
    Search the workspace knowledge base using semantic similarity.
    
    Args:
        query: Search query to find relevant documents
        workspace: Workspace ID for scoped search
        top_k: Number of results to return
        
    Returns:
        Formatted search results with sources and relevance scores
    """
    try:
        client = get_chromadb_client(workspace)
        collection = client.get_or_create_collection("knowledge")
        
        if collection.count() == 0:
            return "📭 Knowledge base is empty. Ingest documents first."
        
        # Filter by run_id if a Nexus is active
        query_params = {
            "query_texts": [query],
            "n_results": min(top_k, collection.count())
        }
        if active_nexus_id and active_nexus_id.strip() and active_nexus_id != "neural_nexus":
            query_params["where"] = {"run_id": active_nexus_id.strip()}

        results = collection.query(**query_params)
        
        if not results['documents'][0]:
            return "No relevant documents found."
        
        output_lines = [f"🔍 Found {len(results['documents'][0])} results for: '{query}'\n"]
        
        for i, (doc, meta, distance) in enumerate(zip(
            results['documents'][0],
            results['metadatas'][0],
            results['distances'][0]
        )):
            source = meta.get('source', 'Unknown')
            relevance = round((1 - distance) * 100, 1)
            output_lines.append(f"**[{i+1}] {source}** (relevance: {relevance}%)")
            output_lines.append(f"```\n{doc[:500]}{'...' if len(doc) > 500 else ''}\n```\n")
        
        return "\n".join(output_lines)
        
    except Exception as e:
        return f"❌ Search error: {str(e)}"


@tool
def list_available_documents(workspace: str = "default") -> str:
    """
    List all documents in a workspace's knowledge base.
    
    Args:
        workspace: Workspace ID
        
    Returns:
        List of documents with chunk counts
    """
    try:
        client = get_chromadb_client(workspace)
        collection = client.get_or_create_collection("knowledge")
        
        if collection.count() == 0:
            return "📭 No documents in knowledge base."
        
        # Get all metadata to extract unique sources
        all_data = collection.get(include=['metadatas'])
        sources = {}
        
        for meta in all_data['metadatas']:
            source = meta.get('source', 'Unknown')
            sources[source] = sources.get(source, 0) + 1
        
        output_lines = [f"📚 Knowledge Base: {len(sources)} documents ({collection.count()} total chunks)\n"]
        for source, chunks in sorted(sources.items()):
            output_lines.append(f"  • {source} ({chunks} chunks)")
        
        return "\n".join(output_lines)
        
    except Exception as e:
        return f"❌ Error listing documents: {str(e)}"


@tool
def read_full_document(document_name: str, workspace: str = "default") -> str:
    """
    Retrieve complete document content from the knowledge base.
    
    Args:
        document_name: Name of document to read
        workspace: Workspace ID
        
    Returns:
        Full document text (pass-by-reference if >5KB)
    """
    try:
        client = get_chromadb_client(workspace)
        collection = client.get_or_create_collection("knowledge")
        
        # Get all chunks for this document
        all_data = collection.get(
            where={"source": document_name},
            include=['documents', 'metadatas']
        )
        
        if not all_data['documents']:
            return f"❌ Document '{document_name}' not found in knowledge base."
        
        # Sort by chunk index if available
        chunks = list(zip(all_data['documents'], all_data['metadatas']))
        chunks.sort(key=lambda x: x[1].get('chunk_index', 0))
        
        full_text = "\n\n".join([doc for doc, _ in chunks])
        
        return smart_output(
            full_text,
            f"{document_name}_full.txt",
            workspace
        )
        
    except Exception as e:
        return f"❌ Error reading document: {str(e)}"
