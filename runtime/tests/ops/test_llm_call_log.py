import pytest
import os
import json
from unittest.mock import patch
from benny.core.models import call_model

def reset_logger():
    """Reset the logger singleton to force re-initialization with new env vars."""
    import benny.ops.llm_logger
    benny.ops.llm_logger._logger = None

@pytest.mark.asyncio
async def test_log_line_written_on_success(tmp_path, monkeypatch):
    """Requirement 6.3.1: verify a JSONL line is appended on success."""
    log_dir = tmp_path / "logs"
    log_dir.mkdir()
    log_file = log_dir / "llm_calls.jsonl"
    
    # Point logger to our tmp path
    monkeypatch.setenv("BENNY_HOME", str(tmp_path))
    reset_logger()
    
    with patch("benny.core.models._run_completion", return_value="mocked response"):
        # We need to simulate a local model or ensure call_model logs everything.
        await call_model("openai/mock", [{"role": "user", "content": "hi"}])
        
    assert log_file.exists()
    with open(log_file, "r") as f:
        line = f.readline()
        data = json.loads(line)
        assert data["model"] == "openai/mock"
        assert data["ok"] is True

def test_log_rotation_at_50mb(tmp_path, monkeypatch):
    """Requirement 6.3.2: assert .1.jsonl exists after rotation."""
    monkeypatch.setenv("BENNY_HOME", str(tmp_path))
    reset_logger()
    from benny.ops.llm_logger import get_logger
    
    # Force a tiny rotation size for testing
    with patch("benny.ops.llm_logger.MAX_BYTES", 100):
        logger = get_logger()
        # Write enough lines to trigger rotation
        for _ in range(20):
            logger.info(json.dumps({"msg": "rotate me" * 10}))
            
    assert (tmp_path / "logs" / "llm_calls.jsonl.1").exists()
