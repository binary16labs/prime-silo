"""
Knowledge Tools - ChromaDB-based semantic search capabilities
"""

from typing import List, Optional

import chromadb
from chromadb.config import Settings
from langchain_core.tools import tool

from ..core.embeddings import LocalEmbeddingFunction
from ..core.workspace import get_workspace_path, smart_output


def get_chromadb_client(workspace_id: str = "default") -> chromadb.PersistentClient:
    """Get ChromaDB client for workspace"""
    chromadb_path = get_workspace_path(workspace_id, "chromadb")
    chromadb_path.mkdir(parents=True, exist_ok=True)
    return chromadb.PersistentClient(
        path=str(chromadb_path), settings=Settings(anonymized_telemetry=False)
    )


def get_knowledge_collection(
    client: "chromadb.PersistentClient", collection_name: str = "knowledge"
):
    """Get/create a RAG collection bound to the local HTTP embedder.

    CRITICAL — every ingest / query / tool path MUST open the knowledge
    collection through this helper. Opening it with a bare
    ``client.get_or_create_collection(name)`` makes ChromaDB fall back to its
    networked ONNX ``DefaultEmbeddingFunction`` (all-MiniLM-L6-v2, 384-dim),
    which (a) needs ``onnxruntime`` + an internet download that is absent in
    the bundled/offline runtime, so ``collection.add`` raises, and (b) does not
    match the 768-dim ``LocalEmbeddingFunction`` used by the agent search tools,
    causing a Chroma dimensionality error when both touch the same collection.
    Routing everything through here keeps a single, offline-safe embedding
    space across ingest, query, chat, adaptive-RAG and the graph agent.
    """
    ef = LocalEmbeddingFunction()
    try:
        return client.get_or_create_collection(collection_name, embedding_function=ef)
    except Exception as e:
        msg = str(e).lower()
        # A collection created by the OLD code with Chroma's default embedder is
        # rejected at open time by Chroma >=1.x ("embedding function conflict:
        # ... persisted: default"). Those vectors are unsearchable with the local
        # embedder anyway, so drop + recreate once. One-time migration; the zero-
        # install exe self-heals with no manual chromadb cleanup.
        if "embedding function" in msg or "conflict" in msg:
            try:
                client.delete_collection(collection_name)
            except Exception:
                pass
            return client.get_or_create_collection(collection_name, embedding_function=ef)
        raise


def heal_collection_dimension(client, collection, collection_name: str, probe_vec: List[float]):
    """Auto-reset a stale vector collection whose stored embedding dimension no
    longer matches the active embedder, and return the collection to use.

    Pre-fix installs built ``knowledge`` with ChromaDB's 384-dim default
    embedder; adding 768-dim local vectors now raises a dimensionality error.
    Those old vectors are unsearchable with the new embedder anyway, so on a
    mismatch we drop and recreate the collection — the user never has to delete
    ``chromadb`` dirs by hand (zero-install exe stays self-healing).

    The check uses an explicit-embedding canary add (bypasses the embedding
    function) so it is deterministic and offline-safe.
    """
    canary_id = "__benny_dim_canary__"
    vec = [float(x) for x in (probe_vec or [])]
    if not vec:
        return collection  # nothing to check against; let real adds proceed
    try:
        collection.add(ids=[canary_id], embeddings=[vec], documents=["canary"])
        # Clean up the canary so it never pollutes retrieval.
        try:
            collection.delete(ids=[canary_id])
        except Exception:
            pass
        return collection
    except Exception as e:
        msg = str(e).lower()
        if "dimension" in msg or "dimensionality" in msg:
            try:
                client.delete_collection(collection_name)
            except Exception:
                pass
            return get_knowledge_collection(client, collection_name)
        # Unknown failure — best-effort canary cleanup, then re-raise so the
        # caller surfaces a real indexing problem rather than masking it.
        try:
            collection.delete(ids=[canary_id])
        except Exception:
            pass
        raise


@tool
def search_knowledge_workspace(
    query: str, workspace: str = "default", top_k: int = 20, active_nexus_id: Optional[str] = None
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
        collection = get_knowledge_collection(client)

        if collection.count() == 0:
            return "📭 Knowledge base is empty. Ingest documents first."

        # Filter by run_id if a Nexus is active
        query_params = {"query_texts": [query], "n_results": min(top_k, collection.count())}
        if active_nexus_id and active_nexus_id.strip() and active_nexus_id != "neural_nexus":
            query_params["where"] = {"run_id": active_nexus_id.strip()}

        results = collection.query(**query_params)

        if not results["documents"][0]:
            return "No relevant documents found."

        output_lines = [f"🔍 Found {len(results['documents'][0])} results for: '{query}'\n"]

        for i, (doc, meta, distance) in enumerate(
            zip(results["documents"][0], results["metadatas"][0], results["distances"][0])
        ):
            source = meta.get("source", "Unknown")
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
        collection = get_knowledge_collection(client)

        if collection.count() == 0:
            return "📭 No documents in knowledge base."

        # Get all metadata to extract unique sources
        all_data = collection.get(include=["metadatas"])
        sources = {}

        for meta in all_data["metadatas"]:
            source = meta.get("source", "Unknown")
            sources[source] = sources.get(source, 0) + 1

        output_lines = [
            f"📚 Knowledge Base: {len(sources)} documents ({collection.count()} total chunks)\n"
        ]
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
        collection = get_knowledge_collection(client)

        # Get all chunks for this document
        all_data = collection.get(
            where={"source": document_name}, include=["documents", "metadatas"]
        )

        if not all_data["documents"]:
            return f"❌ Document '{document_name}' not found in knowledge base."

        # Sort by chunk index if available
        chunks = list(zip(all_data["documents"], all_data["metadatas"]))
        chunks.sort(key=lambda x: x[1].get("chunk_index", 0))

        full_text = "\n\n".join([doc for doc, _ in chunks])

        return smart_output(full_text, f"{document_name}_full.txt", workspace)

    except Exception as e:
        return f"❌ Error reading document: {str(e)}"
