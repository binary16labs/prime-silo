"""
TMDB Connector — The Movie Database API v3.
Free API key: https://www.themoviedb.org/settings/api

Supported entity_types: movie, tv_show, person
Auth: TMDB_API_KEY env var (query parameter)
Rate limit: 40 req/10 sec
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List

import httpx

from benny.core.schema import KnowledgeTriple
from benny.live.connector import BaseConnector, register_connector

logger = logging.getLogger(__name__)

_TMDB_BASE = "https://api.themoviedb.org/3"


@register_connector
class TMDBConnector(BaseConnector):
    source_id = "tmdb"

    async def fetch(self, entity_name: str, entity_type: str) -> Dict[str, Any]:
        api_key = self._get_env("TMDB_API_KEY")

        search_type = {
            "movie": "movie",
            "tv_show": "tv",
            "person": "person",
        }.get(entity_type, "multi")

        search_url = f"{_TMDB_BASE}/search/{search_type}"
        params = {"api_key": api_key, "query": entity_name, "language": "en-US"}

        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.get(search_url, params=params)
            resp.raise_for_status()
            search_data = resp.json()

        results = search_data.get("results", [])
        if not results:
            return {"_api_url": search_url, "_empty": True, "entity_name": entity_name}

        top = results[0]
        item_id = top.get("id")

        # Fetch full detail
        detail_type = "tv" if entity_type == "tv_show" else entity_type if entity_type in ("movie", "person") else "movie"
        detail_url = f"{_TMDB_BASE}/{detail_type}/{item_id}"
        async with httpx.AsyncClient(timeout=15) as client:
            detail_resp = await client.get(detail_url, params={"api_key": api_key, "language": "en-US"})
            detail_resp.raise_for_status()
            detail = detail_resp.json()

        detail["_api_url"] = detail_url
        detail["_entity_name"] = entity_name
        detail["_entity_type"] = entity_type
        return detail

    def parse(self, raw: Dict[str, Any], entity_name: str, entity_type: str, api_url: str) -> List[KnowledgeTriple]:
        if raw.get("_empty"):
            return []

        triples: List[KnowledgeTriple] = []
        name = raw.get("title") or raw.get("name") or entity_name

        def t(pred: str, obj: str, obj_type: str = "Concept") -> None:
            if obj and str(obj).strip():
                triples.append(self._make_triple(name, pred, str(obj).strip(), api_url, raw, object_type=obj_type))

        if entity_type == "movie":
            t("released_on", raw.get("release_date", ""), "Date")
            t("has_runtime_minutes", str(raw.get("runtime", "")), "Quantity")
            t("has_tagline", raw.get("tagline", ""))
            t("has_overview", raw.get("overview", "")[:200] if raw.get("overview") else "")
            for genre in raw.get("genres", []):
                t("has_genre", genre.get("name", ""), "Genre")
            for company in (raw.get("production_companies") or [])[:3]:
                t("produced_by", company.get("name", ""), "Organization")
            for country in (raw.get("production_countries") or [])[:2]:
                t("produced_in", country.get("name", ""), "Country")
            t("has_tmdb_id", str(raw.get("id", "")), "Identifier")
            t("has_imdb_id", raw.get("imdb_id", ""), "Identifier")

        elif entity_type == "tv_show":
            t("first_aired_on", raw.get("first_air_date", ""), "Date")
            t("has_status", raw.get("status", ""))
            t("has_season_count", str(raw.get("number_of_seasons", "")), "Quantity")
            t("has_episode_count", str(raw.get("number_of_episodes", "")), "Quantity")
            for genre in raw.get("genres", []):
                t("has_genre", genre.get("name", ""), "Genre")
            for creator in (raw.get("created_by") or [])[:3]:
                t("created_by", creator.get("name", ""), "Person")
            for network in (raw.get("networks") or [])[:2]:
                t("aired_on", network.get("name", ""), "Organization")
            t("has_tmdb_id", str(raw.get("id", "")), "Identifier")

        elif entity_type == "person":
            t("born_on", raw.get("birthday", ""), "Date")
            t("born_in", raw.get("place_of_birth", ""), "Location")
            t("known_for_department", raw.get("known_for_department", ""))
            t("has_biography", (raw.get("biography") or "")[:200])
            t("has_tmdb_id", str(raw.get("id", "")), "Identifier")
            t("has_imdb_id", raw.get("imdb_id", ""), "Identifier")

        return triples
