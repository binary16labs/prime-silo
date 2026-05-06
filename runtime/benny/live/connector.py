"""
BaseConnector — Abstract base class for all Live Mode data source connectors.

Each connector:
  1. Loads its SourceManifest from workspace/live/sources/<source_id>.yaml
  2. Implements fetch() to call the external API and return raw JSON
  3. Implements parse() to convert raw JSON into List[KnowledgeTriple]
  4. Provides enrich() which orchestrates fetch → cache → parse with
     full provenance: citation=api_url, fragment_id=MD5(raw), fetched_at=now()
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
from abc import ABC, abstractmethod
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Type

import yaml

from benny.core.schema import KnowledgeTriple, SourceManifest

logger = logging.getLogger(__name__)


class BaseConnector(ABC):
    """Abstract base for every Live Mode connector."""

    source_id: str = ""  # Must be set on each subclass

    def __init__(self, workspace: str = "default"):
        self.workspace = workspace
        self.manifest: SourceManifest = self._load_manifest()

    # ------------------------------------------------------------------
    # Manifest loading
    # ------------------------------------------------------------------

    def _load_manifest(self) -> SourceManifest:
        from benny.core.workspace import get_workspace_path
        path = get_workspace_path(self.workspace) / "live" / "sources" / f"{self.source_id}.yaml"
        if not path.exists():
            raise FileNotFoundError(
                f"Source manifest not found: {path}. "
                f"Run ensure_workspace_structure('{self.workspace}') to seed defaults."
            )
        with open(path, encoding="utf-8") as f:
            data = yaml.safe_load(f)
        return SourceManifest(**data)

    # ------------------------------------------------------------------
    # Auth helpers
    # ------------------------------------------------------------------

    def _get_env(self, key: str) -> str:
        """Read a required env var; raises if missing."""
        value = os.environ.get(key, "")
        if not value:
            raise EnvironmentError(
                f"[{self.source_id}] Required env var '{key}' is not set. "
                f"Add it to your environment to enable this connector."
            )
        return value

    # ------------------------------------------------------------------
    # Cache helpers
    # ------------------------------------------------------------------

    def _cache_path(self, entity_name: str, entity_type: str) -> Path:
        from benny.core.workspace import get_workspace_path
        key = hashlib.md5(f"{entity_name}:{entity_type}".encode()).hexdigest()
        return get_workspace_path(self.workspace) / "live" / "cache" / self.source_id / f"{key}.json"

    def _read_cache(self, entity_name: str, entity_type: str, ttl_hours: int) -> Optional[dict]:
        """Return cached raw response if it exists and is within TTL."""
        path = self._cache_path(entity_name, entity_type)
        if not path.exists():
            return None
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
            cached_at = datetime.fromisoformat(payload.get("_cached_at", "1970-01-01"))
            age_hours = (datetime.now(timezone.utc) - cached_at.replace(tzinfo=timezone.utc)).total_seconds() / 3600
            if age_hours <= ttl_hours:
                return payload.get("raw")
        except Exception as e:
            logger.warning(f"[{self.source_id}] Cache read error for {entity_name}: {e}")
        return None

    def _write_cache(self, entity_name: str, entity_type: str, raw: dict) -> None:
        path = self._cache_path(entity_name, entity_type)
        path.parent.mkdir(parents=True, exist_ok=True)
        payload = {"_cached_at": datetime.now(timezone.utc).isoformat(), "raw": raw}
        path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    # ------------------------------------------------------------------
    # Abstract interface
    # ------------------------------------------------------------------

    @abstractmethod
    async def fetch(self, entity_name: str, entity_type: str) -> Dict[str, Any]:
        """Call the external API and return the raw JSON response dict."""

    @abstractmethod
    def parse(self, raw: Dict[str, Any], entity_name: str, entity_type: str, api_url: str) -> List[KnowledgeTriple]:
        """
        Convert raw API response into KnowledgeTriples.
        Must set on every triple:
          - source_type = "live"
          - fetched_at  = ISO-8601 string
          - citation    = api_url
          - fragment_id = MD5(json.dumps(raw))
          - confidence  = self.manifest.confidence_default (or higher if justified)
        """

    # ------------------------------------------------------------------
    # Shared enrich() — orchestrates fetch → cache → parse
    # ------------------------------------------------------------------

    async def enrich(
        self,
        entity_name: str,
        entity_type: str,
        ttl_hours: int = 24,
        run_artifacts_dir: Optional[Path] = None,
    ) -> List[KnowledgeTriple]:
        """
        Fetch or serve from cache, then parse into triples.
        Saves raw response to run_artifacts_dir/raw/ if provided.
        """
        if not self.manifest.enabled:
            logger.info(f"[{self.source_id}] Connector disabled in manifest, skipping {entity_name}")
            return []

        raw = self._read_cache(entity_name, entity_type, ttl_hours)
        cache_hit = raw is not None

        if not cache_hit:
            raw = await self.fetch(entity_name, entity_type)
            self._write_cache(entity_name, entity_type, raw)

        if run_artifacts_dir and not cache_hit:
            raw_dir = run_artifacts_dir / "raw"
            raw_dir.mkdir(parents=True, exist_ok=True)
            key = hashlib.md5(f"{entity_name}:{entity_type}".encode()).hexdigest()
            (raw_dir / f"{self.source_id}_{key}.json").write_text(
                json.dumps(raw, ensure_ascii=False, indent=2), encoding="utf-8"
            )

        api_url = raw.get("_api_url", self.manifest.base_url)
        triples = self.parse(raw, entity_name, entity_type, api_url)
        logger.info(
            f"[{self.source_id}] {entity_name} → {len(triples)} triples "
            f"({'cache' if cache_hit else 'live'})"
        )
        return triples

    # ------------------------------------------------------------------
    # Provenance helper shared by all parse() implementations
    # ------------------------------------------------------------------

    def _make_triple(
        self,
        subject: str,
        predicate: str,
        obj: str,
        api_url: str,
        raw: Dict[str, Any],
        subject_type: str = "Concept",
        object_type: str = "Concept",
        confidence: Optional[float] = None,
    ) -> KnowledgeTriple:
        return KnowledgeTriple(
            subject=subject,
            subject_type=subject_type,
            predicate=predicate,
            object=obj,
            object_type=object_type,
            citation=api_url,
            confidence=confidence if confidence is not None else self.manifest.confidence_default,
            section_title=f"live:{self.source_id}",
            model_id=f"connector:{self.source_id}",
            fragment_id=hashlib.md5(json.dumps(raw, sort_keys=True).encode()).hexdigest(),
            source_type="live",
            fetched_at=datetime.now(timezone.utc).isoformat(),
        )


# =============================================================================
# CONNECTOR REGISTRY
# =============================================================================

_REGISTRY: Dict[str, Type[BaseConnector]] = {}


def register_connector(cls: Type[BaseConnector]) -> Type[BaseConnector]:
    """Decorator that registers a connector class by its source_id."""
    _REGISTRY[cls.source_id] = cls
    return cls


def get_connector(source_id: str, workspace: str = "default") -> BaseConnector:
    """Instantiate a connector by source_id."""
    if source_id not in _REGISTRY:
        raise ValueError(
            f"Unknown connector '{source_id}'. "
            f"Available: {sorted(_REGISTRY.keys())}"
        )
    return _REGISTRY[source_id](workspace=workspace)


def list_connectors() -> List[str]:
    return sorted(_REGISTRY.keys())


def _auto_register_all() -> None:
    """Import all connector modules so their @register_connector decorators fire."""
    from benny.live.connectors import tmdb, spotify, wikipedia, wikidata, google_cse, duckduckgo, youtube  # noqa: F401


_auto_register_all()
