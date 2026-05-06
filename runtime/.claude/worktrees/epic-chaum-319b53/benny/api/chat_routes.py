"""
Chat Routes - RAG-powered chat interface for notebook-scoped Q&A
"""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import List, Optional
from datetime import datetime
from pathlib import Path
import json
from litellm import completion

from ..core.workspace import get_workspace_path
from ..tools.knowledge import get_chromadb_client
from ..core.models import call_model, get_model_config
from ..governance.lineage import track_workflow_start, track_workflow_complete, track_llm_call
import uuid


router = APIRouter()


class SourceCitation(BaseModel):
    source: str
    chunk_index: int
    relevance: float
    text: str


class ChatMessage(BaseModel):
    role: str  # "user" or "assistant"
    content: str
    timestamp: datetime
    sources: Optional[List[SourceCitation]] = None


class ChatRequest(BaseModel):
    notebook_id: str
    message: str
    temperature: float = 0.7
    top_k: int = 20  # Number of RAG chunks to retrieve


class ChatResponse(BaseModel):
    message: str
    sources: List[SourceCitation]
    context_snippets: List[str]


def get_chat_history_file(notebook_id: str, workspace: str = "default") -> Path:
    """Get path to chat history file for a notebook"""
    notebook_dir = get_workspace_path(workspace) / "notebooks" / notebook_id
    notebook_dir.mkdir(parents=True, exist_ok=True)
    return notebook_dir / "chat_history.json"


def load_chat_history(notebook_id: str, workspace: str = "default") -> List[ChatMessage]:
    """Load chat history for a notebook"""
    history_file = get_chat_history_file(notebook_id, workspace)
    
    if not history_file.exists():
        return []
    
    try:
        data = json.loads(history_file.read_text())
        return [ChatMessage(**msg) for msg in data]
    except Exception as e:
        print(f"Error loading chat history: {e}")
        return []


def save_chat_history(notebook_id: str, history: List[ChatMessage], workspace: str = "default"):
    """Save chat history for a notebook"""
    history_file = get_chat_history_file(notebook_id, workspace)
    data = [msg.model_dump(mode='json') for msg in history]
    history_file.write_text(json.dumps(data, indent=2, default=str))


def retrieve_context(notebook_id: str, query: str, top_k: int, workspace: str = "default") -> List[SourceCitation]:
    """Retrieve relevant context from notebook's ChromaDB collection"""
    try:
        client = get_chromadb_client(workspace)
        collection_name = f"notebook_{notebook_id}"
        
        try:
            collection = client.get_collection(collection_name)
        except Exception:
            # Collection doesn't exist yet
            return []
        
        if collection.count() == 0:
            return []
        
        # Query ChromaDB
        import re
        from pathlib import Path
        all_data = collection.get(include=['metadatas'])
        available_sources = set(meta.get('source', 'Unknown') for meta in all_data['metadatas'] if 'source' in meta)
        
        mentioned_sources = []
        query_lower = query.lower()
        for source in available_sources:
            source_stem = Path(source).stem.lower()
            words = [w for w in set(re.split(r'[^a-zA-Z0-9]', source_stem)) if len(w) > 3]
            for w in words:
                if w in query_lower:
                    mentioned_sources.append(source)
                    break
                    
        results_list = []
        
        if mentioned_sources:
            k_per_source = max(3, top_k // len(mentioned_sources))
            for source in mentioned_sources:
                try:
                    res = collection.query(
                        query_texts=[query],
                        n_results=min(k_per_source, collection.count()),
                        where={"source": source}
                    )
                    if res['documents'] and res['documents'][0]:
                        for doc, meta, distance in zip(res['documents'][0], res['metadatas'][0], res['distances'][0]):
                            results_list.append((doc, meta, distance))
                except Exception:
                    pass
            
            try:
                gen_res = collection.query(
                    query_texts=[query],
                    n_results=min(3, collection.count())
                )
                if gen_res['documents'] and gen_res['documents'][0]:
                    for doc, meta, distance in zip(gen_res['documents'][0], gen_res['metadatas'][0], gen_res['distances'][0]):
                        results_list.append((doc, meta, distance))
            except Exception:
                pass
        else:
            try:
                res = collection.query(
                    query_texts=[query],
                    n_results=min(top_k, collection.count())
                )
                if res['documents'] and res['documents'][0]:
                    for doc, meta, distance in zip(res['documents'][0], res['metadatas'][0], res['distances'][0]):
                        results_list.append((doc, meta, distance))
            except Exception:
                pass

        # Format results as source citations
        citations = []
        seen_docs = set()
        for doc, meta, distance in results_list:
            if doc not in seen_docs:
                seen_docs.add(doc)
                citation = SourceCitation(
                    source=meta.get('source', 'Unknown'),
                    chunk_index=meta.get('chunk_index', 0),
                    relevance=round((1 - distance) * 100, 1),
                    text=doc
                )
                citations.append(citation)
        
        return citations
        
    except Exception as e:
        print(f"Error retrieving context: {e}")
        return []


def build_prompt(query: str, context: List[SourceCitation], history: List[ChatMessage]) -> str:
    """Build prompt with context and conversation history"""
    # Build context section
    context_text = "\n\n".join([
        f"[Source: {c.source}, Relevance: {c.relevance}%]\n{c.text}"
        for c in context
    ])
    
    # Build conversation history (last 5 messages)
    history_text = ""
    if history:
        recent_history = history[-5:]  # Last 5 messages
        for msg in recent_history:
            role = "User" if msg.role == "user" else "Assistant"
            history_text += f"{role}: {msg.content}\n\n"
    
    # Construct final prompt
    prompt = f"""You are a helpful AI assistant answering questions about documents in a notebook.

{"CONVERSATION HISTORY:\n" + history_text if history_text else ""}
CONTEXT FROM DOCUMENTS:
{context_text if context_text else "No relevant context found in documents."}

USER QUESTION:
{query}

INSTRUCTIONS:
- Answer based on the provided context from documents
- If the context doesn't contain relevant information, say so
- Cite sources by mentioning the document name (e.g., "According to report.pdf...")
- Be concise and accurate
- If asked to summarize, cover the main points from all relevant sources

ANSWER:"""
    
    return prompt


@router.post("/chat/query")
async def query_chat(request: ChatRequest, workspace: str = "default"):
    """Send a message and get RAG-augmented response"""
    try:
        # Load chat history
        history = load_chat_history(request.notebook_id, workspace)
        
        # Retrieve context from ChromaDB
        context = retrieve_context(
            request.notebook_id,
            request.message,
            request.top_k,
            workspace
        )
        
        # Build prompt with context and history
        prompt = build_prompt(request.message, context, history)
        
        # Unified Audit Tracking
        run_id = f"chat_{str(uuid.uuid4())[:12]}"
        track_workflow_start(
            run_id, 
            "notebook_chat", 
            workspace,
            inputs=[f"session_{request.session_id}"] + ([c.get("title") for c in context] if context else []),
            outputs=[f"chat_reply_{run_id}"]
        )

        # Call LLM
        try:
            # We use call_model to get automatic auditing if we can,
            # but since chat_routes uses completion directly, we'll keep it for now 
            # and just call track_llm_call manually to ensure full visibility.
            
            response = completion(
                model="openai/gpt-3.5-turbo",  # Uses OPENAI_API_BASE env var
                messages=[{"role": "user", "content": prompt}],
                temperature=request.temperature,
            )
            
            assistant_message = response.choices[0].message.content
            
            # Record LLM call to Governance Log
            track_llm_call(
                parent_run_id=run_id,
                model="gpt-3.5-turbo",
                provider="openai",
                usage=response.get("usage"),
                parent_job_name="notebook_chat"
            )
            
            track_workflow_complete(
                run_id, 
                "notebook_chat", 
                workspace, 
                ["rag_retrieval", "generation"], 
                0,
                outputs=[f"chat_reply_{run_id}"]
            )
            
        except Exception as e:
            # Fallback if LLM fails
            if context:
                assistant_message = f"I found {len(context)} relevant passages from your documents, but I'm having trouble generating a response. Here's what I found:\n\n"
                for i, c in enumerate(context[:3], 1):
                    assistant_message += f"{i}. From {c.source}:\n{c.text[:200]}...\n\n"
            else:
                assistant_message = "I couldn't find any relevant information in your documents to answer this question."
        
        # Save user message to history
        user_msg = ChatMessage(
            role="user",
            content=request.message,
            timestamp=datetime.now()
        )
        history.append(user_msg)
        
        # Save assistant message to history with sources
        assistant_msg = ChatMessage(
            role="assistant",
            content=assistant_message,
            timestamp=datetime.now(),
            sources=context
        )
        history.append(assistant_msg)
        
        # Save updated history
        save_chat_history(request.notebook_id, history, workspace)
        
        # Extract context snippets for UI
        context_snippets = [c.text[:300] + "..." if len(c.text) > 300 else c.text for c in context]
        
        return ChatResponse(
            message=assistant_message,
            sources=context,
            context_snippets=context_snippets
        )
        
    except Exception as e:
        raise HTTPException(500, f"Chat query failed: {str(e)}")


@router.get("/chat/history/{notebook_id}")
async def get_chat_history(notebook_id: str, workspace: str = "default", limit: int = 100):
    """Retrieve conversation history for a notebook"""
    try:
        history = load_chat_history(notebook_id, workspace)
        
        # Return most recent messages (up to limit)
        recent = history[-limit:] if len(history) > limit else history
        
        return {
            "notebook_id": notebook_id,
            "messages": [msg.model_dump() for msg in recent],
            "total_count": len(history)
        }
        
    except Exception as e:
        raise HTTPException(500, f"Failed to retrieve chat history: {str(e)}")


@router.delete("/chat/history/{notebook_id}")
async def clear_chat_history(notebook_id: str, workspace: str = "default"):
    """Clear conversation history for a notebook"""
    try:
        history_file = get_chat_history_file(notebook_id, workspace)
        history_file.write_text("[]")
        
        return {
            "status": "cleared",
            "notebook_id": notebook_id
        }
        
    except Exception as e:
        raise HTTPException(500, f"Failed to clear chat history: {str(e)}")
