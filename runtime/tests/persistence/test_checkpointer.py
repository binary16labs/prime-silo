import pytest
import sys
import json
from typing import Iterator
from unittest.mock import patch, MagicMock
from benny.persistence.checkpointer import SQLiteCheckpointer, TimeTravelDebugger, get_checkpointer, PostgresCheckpointer
from langgraph.checkpoint.base import Checkpoint, CheckpointMetadata

@pytest.fixture
def sqlite_cp(tmp_path):
    return SQLiteCheckpointer(db_path=str(tmp_path / "cp.db"))

def test_sqlite_put_writes(sqlite_cp):
    config = {"configurable": {"thread_id": "tw", "checkpoint_id": "cw"}}
    writes = [("ch1", {"val": 42})]
    sqlite_cp.put_writes(config, writes)
    with sqlite_cp._get_connection() as conn:
        row = conn.execute("SELECT * FROM writes").fetchone()
        assert row["channel"] == "ch1"
        assert json.loads(row["write_data"]) == {"val": 42}

def test_get_checkpointer_logic():
    with patch("benny.persistence.checkpointer.POSTGRES_URL", "postgres://test"):
        with patch.dict(sys.modules, {"psycopg_pool": MagicMock()}):
            cp = get_checkpointer("postgres")
            assert isinstance(cp, PostgresCheckpointer)

def test_postgres_full_mock():
    mock_pool = MagicMock()
    mock_conn = MagicMock()
    mock_cur = MagicMock()
    mock_pool.connection.return_value.__enter__.return_value = mock_conn
    mock_conn.cursor.return_value.__enter__.return_value = mock_cur
    
    with patch.dict(sys.modules, {"psycopg_pool": MagicMock()}):
        pc = PostgresCheckpointer("host=test")
        pc._pool = mock_pool
        config = {"configurable": {"thread_id": "t1"}}
        cp = Checkpoint(v=1, id="c1", ts="2026-01-01", channel_values={}, channel_versions={}, versions_seen={}, pending_sends=[])
        pc.put(config, cp, None)
        assert mock_cur.execute.called
        
        mock_cur.fetchone.return_value = ("t1", "c1", None, {"v": 1, "id": "c1", "ts": "...", "channel_values": {}, "channel_versions": {}, "versions_seen": {}, "pending_sends": []}, {}, "2026-01-01")
        res = pc.get_tuple(config)
        assert res[1]["id"] == "c1"

def test_debugger_diff_and_history(sqlite_cp):
    d = TimeTravelDebugger(sqlite_cp)
    tid = "t1"
    config = {"configurable": {"thread_id": tid}}
    cp = Checkpoint(v=1, id="c1", ts="...", channel_values={"x": 1}, channel_versions={}, versions_seen={}, pending_sends=[])
    sqlite_cp.put(config, cp, None)
    
    assert len(d.get_history(tid)) == 1
    cp2 = Checkpoint(v=1, id="c2", ts="...", channel_values={"x": 2}, channel_versions={}, versions_seen={}, pending_sends=[])
    sqlite_cp.put(config, cp2, None)
    
    diff = d.diff_states(tid, "c1", "c2")
    assert "channel_values" in diff["modified"]
