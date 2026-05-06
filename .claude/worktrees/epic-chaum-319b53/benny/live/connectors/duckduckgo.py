"""
DuckDuckGo Instant Answer API Connector.
No API key required. Free. Rate-limited to ~2 req/sec (be polite).
https://duckduckgo.com/api

Returns structured Instant Answer data (Abstract, Infobox, Related Topics).
entity_types: any
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List

import httpx

from benny.core.schema import KnowledgeTriple
from benny.live.connector import BaseConnector, register_connector

logger = logging.getLogger(__name__)

_API_URL = "https://api.duckduckgo.com"
_HEADERS = {"User-Agent": "Benny/1.0 (https://github.com/benny/platform; contact@benny.ai)"}


@register_connector
class DuckDuckGoConnector(BaseConnector):
    source_id = "duckduckgo"

    async def fetch(self, entity_name: str, entity_type: str) -> Dict[str, Any]:
        params = {
            "q": entity_name,
            "format": "json",
            "no_html": "1",
            "skip_disambig": "1",
        }

        async with httpx.AsyncClient(timeout=15, headers=_HEADERS) as client:
            resp = await client.get(_API_URL, params=params)
            resp.raise_for_status()
            data = resp.json()

        data["_api_url"] = f"{_API_URL}/?q={entity_name}&format=json"
        data["_entity_name"] = entity_name
        data["_entity_type"] = entity_type
        return data

    def parse(self, raw: Dict[str, Any], entity_name: str, entity_type: str, api_url: str) -> List[KnowledgeTriple]:
        triples: List[KnowledgeTriple] = []
        name = entity_name

        def t(pred: str, obj: str, obj_type: str = "Concept") -> None:
            if obj and str(obj).strip():
                triples.append(self._make_triple(name, pred, str(obj).strip(), api_url, raw, object_type=obj_type))

        # Abstract text
        abstract = (raw.get("Abstract") or "").strip()
        if abstract:
            t("has_description", abstract[:300])

        # Abstract source URL
        abstract_url = (raw.get("AbstractURL") or "").strip()
        if abstract_url:
            t("has_reference_url", abstract_url, "Identifier")

        # Entity type from DDG
        entity_type_ddg = (raw.get("Type") or "").strip()
        if entity_type_ddg:
            t("has_ddg_type", entity_type_ddg)

        # Infobox fields — structured key-value data when available
        infobox = raw.get("Infobox") or {}
        for entry in (infobox.get("content") or [])[:10]:
            label = (entry.get("label") or "").strip()
            value = (entry.get("value") or "").strip()
            if label and value:
                predicate = f"has_{label.lower().replace(' ', '_').replace('/', '_')}"
                t(predicate, value)

        # Related Topics → extract as "related_to" triples
        for topic in (raw.get("RelatedTopics") or [])[:5]:
            if isinstance(topic, dict) and topic.get("Text"):
                text = topic["Text"].strip()[:150]
                t("related_to", text)

        return triples
