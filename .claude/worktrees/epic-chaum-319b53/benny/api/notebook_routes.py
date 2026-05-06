"""
Notebook Routes - Hierarchical notebook management for isolated document collections
"""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import List, Optional
from datetime import datetime
from pathlib import Path
import json
import uuid
import shutil

from ..core.workspace import get_workspace_path
from ..tools.knowledge import get_chromadb_client


router = APIRouter()


class NotebookCreate(BaseModel):
    path: str  # e.g., "personal>photos" or "acme_bank>OTC>fx_desks"
    display_name: str


class NotebookUpdate(BaseModel):
    path: Optional[str] = None
    display_name: Optional[str] = None


class Notebook(BaseModel):
    id: str
    path: str
    display_name: str
    created_at: datetime
    document_count: int = 0
    message_count: int = 0


def get_notebooks_file(workspace: str = "default") -> Path:
    """Get path to notebooks.json file"""
    workspace_path = get_workspace_path(workspace)
    workspace_path.mkdir(parents=True, exist_ok=True)
    return workspace_path / "notebooks.json"


def load_notebooks(workspace: str = "default") -> List[Notebook]:
    """Load all notebooks from storage"""
    notebooks_file = get_notebooks_file(workspace)
    
    if not notebooks_file.exists():
        return []
    
    try:
        data = json.loads(notebooks_file.read_text())
        return [Notebook(**nb) for nb in data]
    except Exception as e:
        print(f"Error loading notebooks: {e}")
        return []


def save_notebooks(notebooks: List[Notebook], workspace: str = "default"):
    """Save notebooks to storage"""
    notebooks_file = get_notebooks_file(workspace)
    data = [nb.model_dump(mode='json') for nb in notebooks]
    notebooks_file.write_text(json.dumps(data, indent=2, default=str))


def get_notebook_stats(notebook_id: str, workspace: str = "default") -> dict:
    """Get statistics for a notebook"""
    try:
        # Get ChromaDB collection for this notebook
        client = get_chromadb_client(workspace)
        collection_name = f"notebook_{notebook_id}"
        
        try:
            collection = client.get_collection(collection_name)
            document_count = collection.count()
            
            # Count unique sources
            if document_count > 0:
                all_data = collection.get(include=['metadatas'])
                sources = set(meta.get('source', 'Unknown') for meta in all_data['metadatas'])
                unique_sources = len(sources)
            else:
                unique_sources = 0
        except Exception:
            document_count = 0
            unique_sources = 0
        
        # Get chat history count
        chat_history_file = get_workspace_path(workspace) / "notebooks" / notebook_id / "chat_history.json"
        message_count = 0
        if chat_history_file.exists():
            try:
                history = json.loads(chat_history_file.read_text())
                message_count = len(history)
            except Exception:
                pass
        
        return {
            "document_count": document_count,
            "unique_sources": unique_sources,
            "message_count": message_count
        }
    except Exception as e:
        print(f"Error getting notebook stats: {e}")
        return {"document_count": 0, "unique_sources": 0, "message_count": 0}


@router.get("/notebooks")
async def list_notebooks(workspace: str = "default"):
    """List all notebooks in tree structure"""
    try:
        notebooks = load_notebooks(workspace)
        
        # Enrich with current stats
        enriched = []
        for nb in notebooks:
            stats = get_notebook_stats(nb.id, workspace)
            nb_dict = nb.model_dump()
            nb_dict.update(stats)
            enriched.append(nb_dict)
        
        return {
            "notebooks": enriched,
            "count": len(enriched)
        }
    except Exception as e:
        raise HTTPException(500, f"Failed to list notebooks: {str(e)}")


@router.post("/notebooks")
async def create_notebook(request: NotebookCreate, workspace: str = "default"):
    """Create a new notebook"""
    try:
        # Validate path format
        if not request.path or ">" not in request.path:
            # Allow single-level paths
            if not request.path:
                raise HTTPException(400, "Notebook path cannot be empty")
        
        # Load existing notebooks
        notebooks = load_notebooks(workspace)
        
        # Check for duplicate paths
        if any(nb.path == request.path for nb in notebooks):
            raise HTTPException(400, f"Notebook with path '{request.path}' already exists")
        
        # Create new notebook
        new_notebook = Notebook(
            id=str(uuid.uuid4()),
            path=request.path,
            display_name=request.display_name,
            created_at=datetime.now(),
            document_count=0,
            message_count=0
        )
        
        notebooks.append(new_notebook)
        save_notebooks(notebooks, workspace)
        
        # Create notebook directory for chat history
        notebook_dir = get_workspace_path(workspace) / "notebooks" / new_notebook.id
        notebook_dir.mkdir(parents=True, exist_ok=True)
        
        # Initialize empty chat history
        chat_history_file = notebook_dir / "chat_history.json"
        chat_history_file.write_text("[]")
        
        # Create ChromaDB collection for this notebook
        client = get_chromadb_client(workspace)
        collection_name = f"notebook_{new_notebook.id}"
        client.get_or_create_collection(collection_name)
        
        return {
            "status": "created",
            "notebook": new_notebook.model_dump()
        }
        
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"Failed to create notebook: {str(e)}")


@router.put("/notebooks/{notebook_id}")
async def update_notebook(notebook_id: str, request: NotebookUpdate, workspace: str = "default"):
    """Rename or update notebook"""
    try:
        notebooks = load_notebooks(workspace)
        
        # Find the notebook
        notebook = next((nb for nb in notebooks if nb.id == notebook_id), None)
        if not notebook:
            raise HTTPException(404, f"Notebook {notebook_id} not found")
        
        # Update fields
        if request.path:
            # Check for duplicate paths
            if any(nb.path == request.path and nb.id != notebook_id for nb in notebooks):
                raise HTTPException(400, f"Notebook with path '{request.path}' already exists")
            notebook.path = request.path
        
        if request.display_name:
            notebook.display_name = request.display_name
        
        save_notebooks(notebooks, workspace)
        
        return {
            "status": "updated",
            "notebook": notebook.model_dump()
        }
        
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"Failed to update notebook: {str(e)}")


@router.delete("/notebooks/{notebook_id}")
async def delete_notebook(notebook_id: str, workspace: str = "default"):
    """Delete notebook and all associated data"""
    try:
        notebooks = load_notebooks(workspace)
        
        # Find the notebook
        notebook = next((nb for nb in notebooks if nb.id == notebook_id), None)
        if not notebook:
            raise HTTPException(404, f"Notebook {notebook_id} not found")
        
        # Remove from list
        notebooks = [nb for nb in notebooks if nb.id != notebook_id]
        save_notebooks(notebooks, workspace)
        
        # Delete ChromaDB collection
        try:
            client = get_chromadb_client(workspace)
            collection_name = f"notebook_{notebook_id}"
            client.delete_collection(collection_name)
        except Exception as e:
            print(f"Warning: Could not delete ChromaDB collection: {e}")
        
        # Delete chat history and notebook directory
        try:
            notebook_dir = get_workspace_path(workspace) / "notebooks" / notebook_id
            if notebook_dir.exists():
                shutil.rmtree(notebook_dir)
        except Exception as e:
            print(f"Warning: Could not delete notebook directory: {e}")
        
        return {
            "status": "deleted",
            "notebook_id": notebook_id
        }
        
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"Failed to delete notebook: {str(e)}")


@router.get("/notebooks/{notebook_id}")
async def get_notebook(notebook_id: str, workspace: str = "default"):
    """Get details for a specific notebook"""
    try:
        notebooks = load_notebooks(workspace)
        notebook = next((nb for nb in notebooks if nb.id == notebook_id), None)
        
        if not notebook:
            raise HTTPException(404, f"Notebook {notebook_id} not found")
        
        # Get current stats
        stats = get_notebook_stats(notebook_id, workspace)
        result = notebook.model_dump()
        result.update(stats)
        
        return result
        
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"Failed to get notebook: {str(e)}")
