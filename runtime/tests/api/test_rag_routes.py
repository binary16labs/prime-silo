import pytest
from fastapi.testclient import TestClient
from unittest.mock import patch, MagicMock
from benny.api.server import app
from pathlib import Path
import json

client = TestClient(app)

@pytest.fixture
def mock_chroma():
    with patch("benny.api.rag_routes.get_chromadb_client") as mock:
        mock_client = MagicMock()
        mock_collection = MagicMock()
        mock_client.get_or_create_collection.return_value = mock_collection
        mock.return_value = mock_client
        yield mock_client, mock_collection

@pytest.fixture
def mock_task_manager():
    with patch("benny.api.rag_routes.task_manager") as mock:
        # Mock create_task to actually store the task so update_task works
        tasks = {}
        def create_task(ws, type, task_id=None):
            tid = task_id or "test-id"
            t = MagicMock()
            t.id = tid
            tasks[tid] = t
            return t
        mock.create_task.side_effect = create_task
        yield mock

@pytest.fixture
def mock_workspace_path(tmp_path):
    # Some rag_routes handlers use a module-level import
    # (`from ..core.workspace import get_workspace_path`) while the wiki
    # handlers re-import it locally inside the function. Patching BOTH
    # the module binding and the source covers every call site.
    with patch("benny.api.rag_routes.get_workspace_path") as m1, \
         patch("benny.core.workspace.get_workspace_path") as m2:
        m1.return_value = tmp_path
        m2.return_value = tmp_path
        yield tmp_path

def test_get_rag_status_empty(mock_chroma):
    mock_client, mock_collection = mock_chroma
    mock_collection.count.return_value = 0
    mock_collection.get.return_value = {"metadatas": []}
    response = client.get("/api/rag/status?workspace=default")
    assert response.status_code == 200

def test_query_rag_success(mock_chroma):
    _, mock_collection = mock_chroma
    mock_collection.count.return_value = 5
    mock_collection.query.return_value = {
        "documents": [["content 1"]],
        "metadatas": [[{"source": "src1"}]],
        "distances": [[0.1]]
    }
    response = client.post("/api/rag/query", json={"query": "test"})
    assert response.status_code == 200
    assert response.json()["count"] == 1

def test_ingest_files_no_folder(mock_workspace_path, mock_task_manager):
    # tmp_path exists but data_in does not
    response = client.post("/api/rag/ingest", json={"workspace": "default"})
    # Status code might be 404 or 500 depending on catch logic
    assert response.status_code in (404, 500)

def test_ingest_files_success(mock_workspace_path, mock_task_manager, mock_chroma):
    _, mock_collection = mock_chroma
    mock_collection.count.return_value = 1  # serializable total_documents
    data_in = mock_workspace_path / "data_in"
    data_in.mkdir()
    (data_in / "test.txt").write_text("hello world")

    # The ingest endpoint now preflights the embedding provider (a real HTTP
    # call) and fails fast with 503 if it's down. Mock a live provider so the
    # happy path exercises extraction + indexing.
    with patch("benny.api.rag_routes.extract_structured_text", return_value="hello world"), \
         patch("benny.core.embeddings.get_embedding_sync", return_value=[0.1] * 768):
        response = client.post("/api/rag/ingest", json={"workspace": "default", "files": ["test.txt"]})
        assert response.status_code == 200
        body = response.json()
        assert body["status"] in ("completed", "completed_with_errors")
        assert body["indexed_files"] == 1


def test_ingest_files_embedding_provider_down(mock_workspace_path, mock_task_manager, mock_chroma):
    data_in = mock_workspace_path / "data_in"
    data_in.mkdir()
    (data_in / "test.txt").write_text("hello world")

    # Provider unreachable → embeddings.get_embedding_sync returns a zero-vector.
    # Ingest must fail fast (503) instead of reporting a hollow success.
    with patch("benny.api.rag_routes.extract_structured_text", return_value="hello world"), \
         patch("benny.core.embeddings.get_embedding_sync", return_value=[0.0] * 768):
        response = client.post("/api/rag/ingest", json={"workspace": "default", "files": ["test.txt"]})
        assert response.status_code == 503


def test_heal_collection_dimension_resets_stale_collection():
    # A pre-fix collection (384-dim default embedder) raises a dimensionality
    # error when a 768-dim vector is added. heal_collection_dimension must drop
    # and recreate it so the zero-install exe self-heals without manual cleanup.
    from benny.tools import knowledge as kn

    client = MagicMock()
    stale = MagicMock()
    stale.add.side_effect = Exception(
        "Embedding dimension 768 does not match collection dimensionality 384"
    )
    fresh = MagicMock()

    with patch.object(kn, "get_knowledge_collection", return_value=fresh) as recreate:
        result = kn.heal_collection_dimension(client, stale, "knowledge", [0.1] * 768)

    client.delete_collection.assert_called_once_with("knowledge")
    recreate.assert_called_once_with(client, "knowledge")
    assert result is fresh


def test_heal_collection_dimension_keeps_healthy_collection():
    # A healthy collection accepts the canary add → returned unchanged, and the
    # canary is cleaned up so it never pollutes retrieval.
    from benny.tools import knowledge as kn

    client = MagicMock()
    healthy = MagicMock()
    result = kn.heal_collection_dimension(client, healthy, "knowledge", [0.1] * 768)

    assert result is healthy
    client.delete_collection.assert_not_called()
    healthy.delete.assert_called_once()


def test_chat_semantic_success(mock_chroma):
    _, mock_collection = mock_chroma
    mock_collection.count.return_value = 1
    mock_collection.query.return_value = {
        "documents": [["contextual info"]],
        "metadatas": [[{"source": "doc.txt"}]],
        "distances": [[0.1]]
    }
    
    mock_resp = MagicMock()
    mock_resp.status_code = 200
    mock_resp.json.return_value = {
        "choices": [{"message": {"content": "The answer is 42"}}]
    }
    mock_resp.text = '{"answer": "42"}'
    
    with patch("httpx.AsyncClient.post", return_value=mock_resp):
        with patch("benny.api.rag_routes.get_active_model", return_value="openai/gpt-4"):
            response = client.post("/api/rag/chat", json={"query": "What is the answer?", "mode": "semantic"})
            assert response.status_code == 200
            assert "42" in response.json()["answer"]

def test_list_wiki_articles(mock_workspace_path):
    wiki_dir = mock_workspace_path / ".benny" / "wiki"
    wiki_dir.mkdir(parents=True)
    (wiki_dir / "Test_Concept.md").write_text("content")
    
    response = client.get("/api/rag/wiki/articles?workspace=default")
    assert response.status_code == 200
    assert len(response.json()["articles"]) == 1

def test_get_wiki_article_found(mock_workspace_path):
    wiki_dir = mock_workspace_path / ".benny" / "wiki"
    wiki_dir.mkdir(parents=True)
    (wiki_dir / "test.md").write_text("actual content")
    
    response = client.get("/api/rag/wiki/article/test.md?workspace=default")
    assert response.status_code == 200
    assert response.json()["content"] == "actual content"
