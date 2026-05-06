"""
Wikipedia Connector — Wikipedia REST API v1.
No API key required. Free and unlimited (within fair-use).
https://en.wikipedia.org/api/rest_v1/

Supported entity_types: any
Strategy: fetch page summary → extract structured metadata + categories
"""

from __future__ import annotations

import logging
import re
from typing import Any, Dict, List

import httpx

from benny.core.schema import KnowledgeTriple
from benny.live.connector import BaseConnector, register_connector

logger = logging.getLogger(__name__)

_API_BASE = "https://en.wikipedia.org/api/rest_v1"
_HEADERS = {"User-Agent": "Benny/1.0 (https://github.com/skybluecycology/benny; contact@benny.ai)"}


@register_connector
class WikipediaConnector(BaseConnector):
    source_id = "wikipedia"

    async def fetch(self, entity_name: str, entity_type: str) -> Dict[str, Any]:
        title = entity_name.replace(" ", "_")
        summary_url = f"{_API_BASE}/page/summary/{title}"

        async with httpx.AsyncClient(timeout=15, headers=_HEADERS) as client:
            resp = await client.get(summary_url)
            if resp.status_code == 404:
                # Try a search-based redirect
                search_url = f"https://en.wikipedia.org/w/api.php"
                params = {
                    "action": "query", "list": "search", "srsearch": entity_name,
                    "format": "json", "srlimit": 1,
                }
                search_resp = await client.get(search_url, params=params)
                search_resp.raise_for_status()
                results = search_resp.json().get("query", {}).get("search", [])
                if not results:
                    return {"_api_url": summary_url, "_empty": True, "entity_name": entity_name}
                title = results[0]["title"].replace(" ", "_")
                summary_url = f"{_API_BASE}/page/summary/{title}"
                resp = await client.get(summary_url)

            resp.raise_for_status()
            summary = resp.json()

        # Fetch categories for richer triple extraction
        cat_url = (
            f"https://en.wikipedia.org/w/api.php"
            f"?action=query&titles={title}&prop=categories&cllimit=10&format=json"
        )
        async with httpx.AsyncClient(timeout=10, headers=_HEADERS) as client:
            cat_resp = await client.get(cat_url)
            cat_data = cat_resp.json() if cat_resp.status_code == 200 else {}

        pages = cat_data.get("query", {}).get("pages", {})
        cats: List[str] = []
        for page in pages.values():
            cats = [c["title"].replace("Category:", "") for c in page.get("categories", [])]

        summary["_categories"] = cats
        summary["_api_url"] = summary_url
        summary["_entity_name"] = entity_name
        summary["_entity_type"] = entity_type
        return summary

    def parse(self, raw: Dict[str, Any], entity_name: str, entity_type: str, api_url: str) -> List[KnowledgeTriple]:
        if raw.get("_empty"):
            return []

        triples: List[KnowledgeTriple] = []
        name = raw.get("title") or entity_name

        def t(pred: str, obj: str, obj_type: str = "Concept") -> None:
            if obj and str(obj).strip():
                triples.append(self._make_triple(name, pred, str(obj).strip(), api_url, raw, object_type=obj_type))

        # Description and extract
        t("has_description", raw.get("description", ""))
        extract = (raw.get("extract") or "")[:300]
        if extract:
            t("has_summary", extract)

        # Coordinates (if present — locations, cities, etc.)
        coords = raw.get("coordinates")
        if coords:
            t("has_latitude", str(coords.get("lat", "")), "Quantity")
            t("has_longitude", str(coords.get("lon", "")), "Quantity")

        # Wikipedia page URL as an identifier
        page_url = (raw.get("content_urls") or {}).get("desktop", {}).get("page", "")
        t("has_wikipedia_url", page_url, "Identifier")

        # Wikidata QID
        wikidata_id = raw.get("wikibase_item", "")
        t("has_wikidata_id", wikidata_id, "Identifier")

        # Categories → lightweight type hints
        for cat in (raw.get("_categories") or [])[:5]:
            clean = re.sub(r"\d{4}", "", cat).strip(" -")
            if clean:
                t("belongs_to_category", clean)

        return triples
