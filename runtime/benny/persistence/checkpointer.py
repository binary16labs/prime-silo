"""
Benny Persistence - State checkpointing for workflow durability
Supports SQLite (development) and PostgreSQL (production)
"""

from __future__ import annotations

import os
import json
import sqlite3
from typing import Optional, Dict, Any, Iterator
from contextlib import contextmanager
from datetime import datetime
from abc import ABC, abstractmethod

from langgraph.checkpoint.base import BaseCheckpointSaver, Checkpoint, CheckpointMetadata


# =============================================================================
# CONFIGURATION
# =============================================================================

SQLITE_PATH = os.getenv("BENNY_SQLITE_PATH", "workspace/.benny/checkpoints.db")
POSTGRES_URL = os.getenv("BENNY_POSTGRES_URL", "")


# =============================================================================
# SQLITE CHECKPOINTER
# =============================================================================

class SQLiteCheckpointer(BaseCheckpointSaver):
    """
    SQLite-based checkpointer for development and single-instance deployments.
    Stores workflow state for time-travel debugging and recovery.
    """
    
    def __init__(self, db_path: str = SQLITE_PATH):
        super().__init__()
        self.db_path = db_path
        self._ensure_db()
    
    def _ensure_db(self) -> None:
        """Create database and tables if they don't exist"""
        os.makedirs(os.path.dirname(self.db_path), exist_ok=True)
        
        with self._get_connection() as conn:
            conn.execute("""
                CREATE TABLE IF NOT EXISTS checkpoints (
                    thread_id TEXT NOT NULL,
                    checkpoint_id TEXT NOT NULL,
                    parent_checkpoint_id TEXT,
                    checkpoint_data TEXT NOT NULL,
                    metadata TEXT,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    PRIMARY KEY (thread_id, checkpoint_id)
                )
            """)
            
            conn.execute("""
                CREATE INDEX IF NOT EXISTS idx_checkpoints_thread 
                ON checkpoints(thread_id, created_at DESC)
            """)
            
            conn.execute("""
                CREATE TABLE IF NOT EXISTS writes (
                    thread_id TEXT NOT NULL,
                    checkpoint_id TEXT NOT NULL,
                    channel TEXT NOT NULL,
                    write_data TEXT NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    PRIMARY KEY (thread_id, checkpoint_id, channel)
                )
            """)
            conn.commit()
    
    @contextmanager
    def _get_connection(self):
        """Get database connection with context manager"""
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        try:
            yield conn
        finally:
            conn.close()
    
    def get_tuple(self, config: Dict[str, Any]) -> Optional[tuple]:
        """Get checkpoint tuple by config"""
        thread_id = config["configurable"].get("thread_id")
        checkpoint_id = config["configurable"].get("checkpoint_id")
        
        with self._get_connection() as conn:
            if checkpoint_id:
                row = conn.execute(
                    "SELECT * FROM checkpoints WHERE thread_id = ? AND checkpoint_id = ?",
                    (thread_id, checkpoint_id)
                ).fetchone()
            else:
                # Get latest checkpoint for thread
                row = conn.execute(
                    "SELECT * FROM checkpoints WHERE thread_id = ? ORDER BY created_at DESC LIMIT 1",
                    (thread_id,)
                ).fetchone()
            
            if row:
                checkpoint = Checkpoint(**json.loads(row["checkpoint_data"]))
                metadata = CheckpointMetadata(**json.loads(row["metadata"])) if row["metadata"] else None
                
                return (
                    {
                        "configurable": {
                            "thread_id": row["thread_id"],
                            "checkpoint_id": row["checkpoint_id"],
                        }
                    },
                    checkpoint,
                    metadata,
                    row["parent_checkpoint_id"],
                )
        
        return None
    
    def list(self, config: Dict[str, Any]) -> Iterator[tuple]:
        """List all checkpoints for a thread"""
        thread_id = config["configurable"].get("thread_id")
        
        with self._get_connection() as conn:
            rows = conn.execute(
                "SELECT * FROM checkpoints WHERE thread_id = ? ORDER BY created_at DESC",
                (thread_id,)
            ).fetchall()
            
            for row in rows:
                checkpoint = Checkpoint(**json.loads(row["checkpoint_data"]))
                metadata = CheckpointMetadata(**json.loads(row["metadata"])) if row["metadata"] else None
                
                yield (
                    {
                        "configurable": {
                            "thread_id": row["thread_id"],
                            "checkpoint_id": row["checkpoint_id"],
                        }
                    },
                    checkpoint,
                    metadata,
                    row["parent_checkpoint_id"],
                )
    
    def put(
        self,
        config: Dict[str, Any],
        checkpoint: Checkpoint,
        metadata: CheckpointMetadata,
    ) -> Dict[str, Any]:
        """Save a checkpoint"""
        thread_id = config["configurable"]["thread_id"]
        checkpoint_id = checkpoint.get("id", str(datetime.now().timestamp()))
        parent_id = config["configurable"].get("checkpoint_id")
        
        with self._get_connection() as conn:
            conn.execute(
                """
                INSERT OR REPLACE INTO checkpoints 
                (thread_id, checkpoint_id, parent_checkpoint_id, checkpoint_data, metadata)
                VALUES (?, ?, ?, ?, ?)
                """,
                (
                    thread_id,
                    checkpoint_id,
                    parent_id,
                    json.dumps(dict(checkpoint)),
                    json.dumps(dict(metadata)) if metadata else None,
                )
            )
            conn.commit()
        
        return {
            "configurable": {
                "thread_id": thread_id,
                "checkpoint_id": checkpoint_id,
            }
        }
    
    def put_writes(
        self,
        config: Dict[str, Any],
        writes: list[tuple[str, Any]],
    ) -> None:
        """Save channel writes"""
        thread_id = config["configurable"]["thread_id"]
        checkpoint_id = config["configurable"].get("checkpoint_id", "")
        
        with self._get_connection() as conn:
            for channel, data in writes:
                conn.execute(
                    """
                    INSERT OR REPLACE INTO writes 
                    (thread_id, checkpoint_id, channel, write_data)
                    VALUES (?, ?, ?, ?)
                    """,
                    (thread_id, checkpoint_id, channel, json.dumps(data))
                )
            conn.commit()


# =============================================================================
# POSTGRESQL CHECKPOINTER
# =============================================================================

class PostgresCheckpointer(BaseCheckpointSaver):
    """
    PostgreSQL-based checkpointer for production deployments.
    Provides durability and supports multi-instance setups.
    """
    
    def __init__(self, connection_string: str = POSTGRES_URL):
        super().__init__()
        self.connection_string = connection_string
        self._pool = None
    
    def _get_pool(self):
        """Get or create connection pool"""
        if self._pool is None:
            try:
                import psycopg_pool
                self._pool = psycopg_pool.ConnectionPool(
                    self.connection_string,
                    min_size=1,
                    max_size=10
                )
                self._ensure_tables()
            except ImportError:
                raise ImportError("psycopg[pool] required for PostgreSQL. Install with: pip install psycopg[pool]")
        return self._pool
    
    def _ensure_tables(self) -> None:
        """Create tables if they don't exist"""
        with self._get_pool().connection() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    CREATE TABLE IF NOT EXISTS benny_checkpoints (
                        thread_id TEXT NOT NULL,
                        checkpoint_id TEXT NOT NULL,
                        parent_checkpoint_id TEXT,
                        checkpoint_data JSONB NOT NULL,
                        metadata JSONB,
                        created_at TIMESTAMPTZ DEFAULT NOW(),
                        PRIMARY KEY (thread_id, checkpoint_id)
                    )
                """)
                
                cur.execute("""
                    CREATE INDEX IF NOT EXISTS idx_benny_checkpoints_thread 
                    ON benny_checkpoints(thread_id, created_at DESC)
                """)
                
                cur.execute("""
                    CREATE TABLE IF NOT EXISTS benny_writes (
                        thread_id TEXT NOT NULL,
                        checkpoint_id TEXT NOT NULL,
                        channel TEXT NOT NULL,
                        write_data JSONB NOT NULL,
                        created_at TIMESTAMPTZ DEFAULT NOW(),
                        PRIMARY KEY (thread_id, checkpoint_id, channel)
                    )
                """)
            conn.commit()
    
    def get_tuple(self, config: Dict[str, Any]) -> Optional[tuple]:
        """Get checkpoint tuple by config"""
        thread_id = config["configurable"].get("thread_id")
        checkpoint_id = config["configurable"].get("checkpoint_id")
        
        with self._get_pool().connection() as conn:
            with conn.cursor() as cur:
                if checkpoint_id:
                    cur.execute(
                        "SELECT * FROM benny_checkpoints WHERE thread_id = %s AND checkpoint_id = %s",
                        (thread_id, checkpoint_id)
                    )
                else:
                    cur.execute(
                        "SELECT * FROM benny_checkpoints WHERE thread_id = %s ORDER BY created_at DESC LIMIT 1",
                        (thread_id,)
                    )
                
                row = cur.fetchone()
                
                if row:
                    checkpoint = Checkpoint(**row[3])
                    metadata = CheckpointMetadata(**row[4]) if row[4] else None
                    
                    return (
                        {
                            "configurable": {
                                "thread_id": row[0],
                                "checkpoint_id": row[1],
                            }
                        },
                        checkpoint,
                        metadata,
                        row[2],
                    )
        
        return None
    
    def list(self, config: Dict[str, Any]) -> Iterator[tuple]:
        """List all checkpoints for a thread"""
        thread_id = config["configurable"].get("thread_id")
        
        with self._get_pool().connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT * FROM benny_checkpoints WHERE thread_id = %s ORDER BY created_at DESC",
                    (thread_id,)
                )
                
                for row in cur.fetchall():
                    checkpoint = Checkpoint(**row[3])
                    metadata = CheckpointMetadata(**row[4]) if row[4] else None
                    
                    yield (
                        {
                            "configurable": {
                                "thread_id": row[0],
                                "checkpoint_id": row[1],
                            }
                        },
                        checkpoint,
                        metadata,
                        row[2],
                    )
    
    def put(
        self,
        config: Dict[str, Any],
        checkpoint: Checkpoint,
        metadata: CheckpointMetadata,
    ) -> Dict[str, Any]:
        """Save a checkpoint"""
        thread_id = config["configurable"]["thread_id"]
        checkpoint_id = checkpoint.get("id", str(datetime.now().timestamp()))
        parent_id = config["configurable"].get("checkpoint_id")
        
        with self._get_pool().connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO benny_checkpoints 
                    (thread_id, checkpoint_id, parent_checkpoint_id, checkpoint_data, metadata)
                    VALUES (%s, %s, %s, %s, %s)
                    ON CONFLICT (thread_id, checkpoint_id) DO UPDATE SET
                        checkpoint_data = EXCLUDED.checkpoint_data,
                        metadata = EXCLUDED.metadata
                    """,
                    (
                        thread_id,
                        checkpoint_id,
                        parent_id,
                        json.dumps(dict(checkpoint)),
                        json.dumps(dict(metadata)) if metadata else None,
                    )
                )
            conn.commit()
        
        return {
            "configurable": {
                "thread_id": thread_id,
                "checkpoint_id": checkpoint_id,
            }
        }
    
    def put_writes(
        self,
        config: Dict[str, Any],
        writes: list[tuple[str, Any]],
    ) -> None:
        """Save channel writes"""
        thread_id = config["configurable"]["thread_id"]
        checkpoint_id = config["configurable"].get("checkpoint_id", "")
        
        with self._get_pool().connection() as conn:
            with conn.cursor() as cur:
                for channel, data in writes:
                    cur.execute(
                        """
                        INSERT INTO benny_writes 
                        (thread_id, checkpoint_id, channel, write_data)
                        VALUES (%s, %s, %s, %s)
                        ON CONFLICT (thread_id, checkpoint_id, channel) DO UPDATE SET
                            write_data = EXCLUDED.write_data
                        """,
                        (thread_id, checkpoint_id, channel, json.dumps(data))
                    )
            conn.commit()


# =============================================================================
# FACTORY FUNCTION
# =============================================================================

def get_checkpointer(backend: str = "sqlite") -> BaseCheckpointSaver:
    """
    Get the appropriate checkpointer based on configuration.
    
    Args:
        backend: "sqlite" or "postgres"
    
    Returns:
        Configured checkpointer instance
    """
    if backend == "postgres" and POSTGRES_URL:
        return PostgresCheckpointer(POSTGRES_URL)
    return SQLiteCheckpointer(SQLITE_PATH)


# =============================================================================
# TIME TRAVEL DEBUGGING
# =============================================================================

class TimeTravelDebugger:
    """
    Utility for debugging workflow state across checkpoints.
    Enables replay and inspection of historical states.
    """
    
    def __init__(self, checkpointer: BaseCheckpointSaver):
        self.checkpointer = checkpointer
    
    def get_history(self, thread_id: str) -> list[dict]:
        """Get all checkpoints for a thread as a list"""
        config = {"configurable": {"thread_id": thread_id}}
        
        history = []
        for config, checkpoint, metadata, parent_id in self.checkpointer.list(config):
            history.append({
                "checkpoint_id": config["configurable"]["checkpoint_id"],
                "parent_id": parent_id,
                "state": dict(checkpoint),
                "metadata": dict(metadata) if metadata else None,
            })
        
        return history
    
    def get_state_at(self, thread_id: str, checkpoint_id: str) -> Optional[dict]:
        """Get state at a specific checkpoint"""
        config = {
            "configurable": {
                "thread_id": thread_id,
                "checkpoint_id": checkpoint_id,
            }
        }
        
        result = self.checkpointer.get_tuple(config)
        if result:
            _, checkpoint, _, _ = result
            return dict(checkpoint)
        return None
    
    def diff_states(self, thread_id: str, checkpoint_a: str, checkpoint_b: str) -> dict:
        """Compare two checkpoint states"""
        state_a = self.get_state_at(thread_id, checkpoint_a) or {}
        state_b = self.get_state_at(thread_id, checkpoint_b) or {}
        
        # Find differences
        added = {k: state_b[k] for k in state_b if k not in state_a}
        removed = {k: state_a[k] for k in state_a if k not in state_b}
        modified = {
            k: {"before": state_a[k], "after": state_b[k]}
            for k in state_a
            if k in state_b and state_a[k] != state_b[k]
        }
        
        return {
            "added": added,
            "removed": removed,
            "modified": modified,
        }
