"""
YouTube Data API v3 Connector.
Free: 10,000 quota units/day.
Get a key: https://console.cloud.google.com → Enable "YouTube Data API v3"

Supported entity_types: video, channel, playlist, music_video
Auth: YOUTUBE_API_KEY env var
Quota cost: search.list = 100 units, videos.list = 1 unit, channels.list = 1 unit

Enrichment strategy:
  1. search.list(q=entity_name) → top result videoId / channelId
  2. videos.list(part=snippet,contentDetails,statistics) → full metadata
  3. Extract title, channel, tags, duration, publish date, view/like counts
"""

from __future__ import annotations

import logging
import re
from typing import Any, Dict, List

import httpx

from benny.core.schema import KnowledgeTriple
from benny.live.connector import BaseConnector, register_connector

logger = logging.getLogger(__name__)

_API_BASE = "https://www.googleapis.com/youtube/v3"


def _iso8601_duration_to_seconds(duration: str) -> str:
    """Convert PT4M13S → '253' seconds (as string for the triple object)."""
    match = re.match(r"PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?", duration or "")
    if not match:
        return ""
    h, m, s = (int(x or 0) for x in match.groups())
    return str(h * 3600 + m * 60 + s)


@register_connector
class YouTubeConnector(BaseConnector):
    source_id = "youtube"

    async def fetch(self, entity_name: str, entity_type: str) -> Dict[str, Any]:
        api_key = self._get_env("YOUTUBE_API_KEY")

        # Step 1 — search for the entity
        search_type = "channel" if entity_type == "channel" else "video"
        search_params: Dict[str, Any] = {
            "key": api_key,
            "q": entity_name,
            "part": "snippet",
            "type": search_type,
            "maxResults": 1,
        }
        # Bias music searches toward the Music category (id=10)
        if entity_type in ("music_video", "track", "song"):
            search_params["videoCategoryId"] = "10"

        search_url = f"{_API_BASE}/search"
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.get(search_url, params=search_params)
            resp.raise_for_status()
            search_data = resp.json()

        items = search_data.get("items", [])
        if not items:
            return {"_api_url": search_url, "_empty": True, "entity_name": entity_name}

        top = items[0]
        id_block = top.get("id", {})
        video_id = id_block.get("videoId")
        channel_id = id_block.get("channelId")

        # Step 2 — fetch full metadata
        if entity_type == "channel" and channel_id:
            detail_url = f"{_API_BASE}/channels"
            detail_params = {
                "key": api_key,
                "id": channel_id,
                "part": "snippet,statistics,brandingSettings",
            }
        elif video_id:
            detail_url = f"{_API_BASE}/videos"
            detail_params = {
                "key": api_key,
                "id": video_id,
                "part": "snippet,contentDetails,statistics,topicDetails",
            }
        else:
            return {"_api_url": search_url, "_empty": True, "entity_name": entity_name}

        async with httpx.AsyncClient(timeout=15) as client:
            detail_resp = await client.get(detail_url, params=detail_params)
            detail_resp.raise_for_status()
            detail = detail_resp.json()

        detail_items = detail.get("items", [])
        if not detail_items:
            return {"_api_url": detail_url, "_empty": True, "entity_name": entity_name}

        result = detail_items[0]
        result["_api_url"] = f"{detail_url}?id={video_id or channel_id}"
        result["_entity_name"] = entity_name
        result["_entity_type"] = entity_type
        return result

    def parse(self, raw: Dict[str, Any], entity_name: str, entity_type: str, api_url: str) -> List[KnowledgeTriple]:
        if raw.get("_empty"):
            return []

        triples: List[KnowledgeTriple] = []
        snippet = raw.get("snippet", {})
        stats = raw.get("statistics", {})
        content = raw.get("contentDetails", {})
        topics = raw.get("topicDetails", {})
        name = snippet.get("title") or entity_name

        def t(pred: str, obj: str, obj_type: str = "Concept") -> None:
            if obj and str(obj).strip():
                triples.append(self._make_triple(name, pred, str(obj).strip(), api_url, raw, object_type=obj_type))

        if entity_type == "channel":
            branding = raw.get("brandingSettings", {}).get("channel", {})
            t("has_description", (snippet.get("description") or "")[:250])
            t("published_on", snippet.get("publishedAt", "")[:10], "Date")
            t("has_country", snippet.get("country", ""), "Country")
            t("has_subscriber_count", stats.get("subscriberCount", ""), "Quantity")
            t("has_video_count", stats.get("videoCount", ""), "Quantity")
            t("has_view_count", stats.get("viewCount", ""), "Quantity")
            t("has_keywords", branding.get("keywords", ""))
            t("has_youtube_channel_id", raw.get("id", ""), "Identifier")

        else:
            # video / music_video / default
            t("uploaded_by", snippet.get("channelTitle", ""), "Organization")
            t("published_on", (snippet.get("publishedAt") or "")[:10], "Date")
            t("has_description", (snippet.get("description") or "")[:250])
            t("has_youtube_video_id", raw.get("id", ""), "Identifier")

            # Tags (cap at 8)
            for tag in (snippet.get("tags") or [])[:8]:
                t("has_tag", tag)

            # Duration → seconds
            duration_iso = content.get("duration", "")
            duration_secs = _iso8601_duration_to_seconds(duration_iso)
            if duration_secs:
                t("has_duration_seconds", duration_secs, "Quantity")

            t("has_definition", content.get("definition", ""))  # hd / sd
            t("has_caption", content.get("caption", ""))        # true / false

            # Statistics
            t("has_view_count", stats.get("viewCount", ""), "Quantity")
            t("has_like_count", stats.get("likeCount", ""), "Quantity")
            t("has_comment_count", stats.get("commentCount", ""), "Quantity")

            # Topic categories (music genre, film, etc.)
            for url in (topics.get("topicCategories") or [])[:5]:
                # URLs like https://en.wikipedia.org/wiki/Rock_music → "Rock music"
                label = url.split("/")[-1].replace("_", " ")
                t("belongs_to_topic", label)

        return triples
