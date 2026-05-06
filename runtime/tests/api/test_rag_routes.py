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
    data_in = mock_workspace_path / "data_in"
    data_in.mkdir()
    (data_in / "test.txt").write_text("hello world")
    
    with patch("benny.api.rag_routes.extract_structured_text", return_value="hello world"):
        response = client.post("/api/rag/ingest", json={"workspace": "default", "files": ["test.txt"]})
        assert response.status_code == 200

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
