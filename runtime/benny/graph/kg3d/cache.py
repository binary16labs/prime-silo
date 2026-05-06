import sqlite3
import json
import logging
from pathlib import Path
from typing import Dict, Optional
from .schema import NodeMetrics
from .ontology import Graph, content_hash

logger = logging.getLogger(__name__)

CACHE_DIR = Path("workspace/.benny/kg3d")
CACHE_FILE = CACHE_DIR / "metrics.sqlite"

def init_cache():
    """Initializes the SQLite cache database."""
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(CACHE_FILE) as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS metrics_cache (
                graph_hash TEXT PRIMARY KEY,
                metrics_json TEXT,
                computed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)

def get_cached_metrics(graph: Graph) -> Optional[Dict[str, NodeMetrics]]:
    """Retrieves cached metrics if the graph hash matches."""
    g_hash = content_hash(graph)
    try:
        with sqlite3.connect(CACHE_FILE) as conn:
            cursor = conn.execute("SELECT metrics_json FROM metrics_cache WHERE graph_hash = ?", (g_hash,))
            row = cursor.fetchone()
            if row:
                data = json.loads(row[0])
                return {node_id: NodeMetrics(**m) for node_id, m in data.items()}
    except Exception as e:
        logger.warning("Cache retrieval failed: %s", e)
    return None

def save_metrics_to_cache(graph: Graph, metrics: Dict[str, NodeMetrics]):
    """Saves computed metrics to the SQLite cache."""
    g_hash = content_hash(graph)
    metrics_json = json.dumps({node_id: m.model_dump(mode="json") for node_id, m in metrics.items()})
    
    try:
        with sqlite3.connect(CACHE_FILE) as conn:
            conn.execute("""
                INSERT OR REPLACE INTO metrics_cache (graph_hash, metrics_json)
                VALUES (?, ?)
            """, (g_hash, metrics_json))
    except Exception as e:
        logger.error("Cache save failed: %s", e)
