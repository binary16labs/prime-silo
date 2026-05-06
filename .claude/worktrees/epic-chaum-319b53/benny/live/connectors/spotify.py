"""
Spotify Connector — Spotify Web API.
Free: https://developer.spotify.com/dashboard

Supported entity_types: track, artist, album
Auth: SPOTIFY_CLIENT_ID + SPOTIFY_CLIENT_SECRET (OAuth2 client credentials)
Rate limit: ~10 req/sec (generous free tier)
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

import httpx

from benny.core.schema import KnowledgeTriple
from benny.live.connector import BaseConnector, register_connector

logger = logging.getLogger(__name__)

_TOKEN_URL = "https://accounts.spotify.com/api/token"
_API_BASE = "https://api.spotify.com/v1"

_token_cache: Dict[str, str] = {}  # simple in-process cache (client_id → token)


async def _get_token(client_id: str, client_secret: str) -> str:
    if client_id in _token_cache:
        return _token_cache[client_id]
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.post(
            _TOKEN_URL,
            data={"grant_type": "client_credentials"},
            auth=(client_id, client_secret),
        )
        resp.raise_for_status()
        token = resp.json()["access_token"]
        _token_cache[client_id] = token
        return token


@register_connector
class SpotifyConnector(BaseConnector):
    source_id = "spotify"

    async def fetch(self, entity_name: str, entity_type: str) -> Dict[str, Any]:
        client_id = self._get_env("SPOTIFY_CLIENT_ID")
        client_secret = self._get_env("SPOTIFY_CLIENT_SECRET")
        token = await _get_token(client_id, client_secret)
        headers = {"Authorization": f"Bearer {token}"}

        search_type = {"track": "track", "artist": "artist", "album": "album"}.get(entity_type, "track")
        search_url = f"{_API_BASE}/search"
        params = {"q": entity_name, "type": search_type, "limit": 1}

        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.get(search_url, params=params, headers=headers)
            resp.raise_for_status()
            search_data = resp.json()

        results_key = f"{search_type}s"
        items = search_data.get(results_key, {}).get("items", [])
        if not items:
            return {"_api_url": search_url, "_empty": True, "entity_name": entity_name}

        top = items[0]
        item_id = top["id"]

        # Fetch full detail
        if search_type == "track":
            detail_url = f"{_API_BASE}/tracks/{item_id}"
        elif search_type == "artist":
            detail_url = f"{_API_BASE}/artists/{item_id}"
        else:
            detail_url = f"{_API_BASE}/albums/{item_id}"

        async with httpx.AsyncClient(timeout=15) as client:
            detail_resp = await client.get(detail_url, headers=headers)
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
        name = raw.get("name") or entity_name

        def t(pred: str, obj: str, obj_type: str = "Concept") -> None:
            if obj and str(obj).strip():
                triples.append(self._make_triple(name, pred, str(obj).strip(), api_url, raw, object_type=obj_type))

        if entity_type == "track":
            album = raw.get("album") or {}
            t("released_on", album.get("release_date", ""), "Date")
            t("belongs_to_album", album.get("name", ""))
            t("has_duration_ms", str(raw.get("duration_ms", "")), "Quantity")
            t("has_track_number", str(raw.get("track_number", "")), "Quantity")
            t("has_explicit_content", str(raw.get("explicit", "")))
            t("has_spotify_id", raw.get("id", ""), "Identifier")
            for artist in (raw.get("artists") or [])[:5]:
                t("performed_by", artist.get("name", ""), "Person")

        elif entity_type == "artist":
            t("has_follower_count", str((raw.get("followers") or {}).get("total", "")), "Quantity")
            t("has_popularity_score", str(raw.get("popularity", "")), "Quantity")
            t("has_spotify_id", raw.get("id", ""), "Identifier")
            for genre in (raw.get("genres") or [])[:5]:
                t("has_genre", genre, "Genre")

        elif entity_type == "album":
            t("released_on", raw.get("release_date", ""), "Date")
            t("has_track_count", str(raw.get("total_tracks", "")), "Quantity")
            t("has_album_type", raw.get("album_type", ""))
            t("has_label", raw.get("label", ""), "Organization")
            t("has_spotify_id", raw.get("id", ""), "Identifier")
            for artist in (raw.get("artists") or [])[:3]:
                t("performed_by", artist.get("name", ""), "Person")
            for genre in (raw.get("genres") or [])[:5]:
                t("has_genre", genre, "Genre")

        return triples
