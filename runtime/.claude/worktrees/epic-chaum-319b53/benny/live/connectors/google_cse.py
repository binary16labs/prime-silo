"""
Google Custom Search Engine (CSE) Connector.
Free: 100 queries/day. Requires GOOGLE_CSE_API_KEY + GOOGLE_CSE_CX env vars.
https://developers.google.com/custom-search/v1/overview

Returns search snippets → LLM parses them into triples (lower confidence).
entity_types: any (general purpose fallback)
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List

import httpx

from benny.core.schema import KnowledgeTriple
from benny.live.connector import BaseConnector, register_connector

logger = logging.getLogger(__name__)

_API_URL = "https://www.googleapis.com/customsearch/v1"


@register_connector
class GoogleCSEConnector(BaseConnector):
    source_id = "google_cse"

    async def fetch(self, entity_name: str, entity_type: str) -> Dict[str, Any]:
        api_key = self._get_env("GOOGLE_CSE_API_KEY")
        cx = self._get_env("GOOGLE_CSE_CX")

        params = {
            "key": api_key,
            "cx": cx,
            "q": f"{entity_name} {entity_type} facts",
            "num": 5,
        }

        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.get(_API_URL, params=params)
            resp.raise_for_status()
            data = resp.json()

        data["_api_url"] = _API_URL
        data["_entity_name"] = entity_name
        data["_entity_type"] = entity_type
        return data

    def parse(self, raw: Dict[str, Any], entity_name: str, entity_type: str, api_url: str) -> List[KnowledgeTriple]:
        items = raw.get("items", [])
        if not items:
            return []

        triples: List[KnowledgeTriple] = []

        # Extract what we can from snippets without an LLM pass
        for item in items[:3]:
            snippet = (item.get("snippet") or "").strip()
            if snippet:
                triples.append(self._make_triple(
                    entity_name, "has_search_snippet", snippet[:300],
                    item.get("link", api_url), raw,
                    confidence=self.manifest.confidence_default,
                ))
            title = (item.get("title") or "").strip()
            link = (item.get("link") or "").strip()
            if title and link:
                triples.append(self._make_triple(
                    entity_name, "has_reference_url", link,
                    link, raw,
                    object_type="Identifier",
                    confidence=self.manifest.confidence_default,
                ))

        return triples
