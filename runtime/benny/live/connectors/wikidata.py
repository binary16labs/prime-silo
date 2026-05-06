"""
Wikidata Connector — Wikidata SPARQL endpoint.
No API key required. Free and unlimited (within fair-use).
https://query.wikidata.org/

Returns richly structured, multilingual data with permanent QIDs.
Rate limit: ~2 req/sec (be conservative to avoid blocks).
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List

import httpx

from benny.core.schema import KnowledgeTriple
from benny.live.connector import BaseConnector, register_connector

logger = logging.getLogger(__name__)

_SPARQL_URL = "https://query.wikidata.org/sparql"
_HEADERS = {
    "User-Agent": "Benny/1.0 (https://github.com/skybluecycology/benny; contact@benny.ai)",
    "Accept": "application/sparql-results+json",
}

_ENTITY_SEARCH_QUERY = """
SELECT ?item ?itemLabel ?itemDescription WHERE {{
  SERVICE wikibase:mwapi {{
    bd:serviceParam wikibase:endpoint "www.wikidata.org";
                    wikibase:api "EntitySearch";
                    mwapi:search "{name}";
                    mwapi:language "en".
    ?item wikibase:apiOutputItem mwapi:item.
  }}
  SERVICE wikibase:label {{ bd:serviceParam wikibase:language "en". }}
}}
LIMIT 1
"""

_FILM_PROPERTIES_QUERY = """
SELECT ?prop ?propLabel ?value ?valueLabel WHERE {{
  VALUES ?prop {{
    wdt:P57   # director
    wdt:P577  # publication date
    wdt:P136  # genre
    wdt:P495  # country of origin
    wdt:P840  # narrative location
    wdt:P344  # director of photography
    wdt:P162  # producer
    wdt:P345  # IMDb ID
    wdt:P2047 # duration (minutes)
    wdt:P1476 # title
  }}
  <{qid}> ?prop ?value.
  SERVICE wikibase:label {{ bd:serviceParam wikibase:language "en". }}
}}
"""

_PERSON_PROPERTIES_QUERY = """
SELECT ?prop ?propLabel ?value ?valueLabel WHERE {{
  VALUES ?prop {{
    wdt:P569  # date of birth
    wdt:P570  # date of death
    wdt:P19   # place of birth
    wdt:P27   # country of citizenship
    wdt:P106  # occupation
    wdt:P136  # genre
    wdt:P18   # image (skip in triples)
    wdt:P345  # IMDb ID
    wdt:P434  # MusicBrainz artist ID
  }}
  <{qid}> ?prop ?value.
  SERVICE wikibase:label {{ bd:serviceParam wikibase:language "en". }}
}}
"""

_GENERIC_QUERY = """
SELECT ?prop ?propLabel ?value ?valueLabel WHERE {{
  VALUES ?prop {{
    wdt:P31   # instance of
    wdt:P17   # country
    wdt:P131  # located in
    wdt:P571  # inception
    wdt:P577  # publication date
    wdt:P136  # genre
    wdt:P176  # manufacturer
    wdt:P495  # country of origin
  }}
  <{qid}> ?prop ?value.
  SERVICE wikibase:label {{ bd:serviceParam wikibase:language "en". }}
}}
"""


async def _sparql(query: str) -> Dict[str, Any]:
    async with httpx.AsyncClient(timeout=20, headers=_HEADERS) as client:
        resp = await client.get(_SPARQL_URL, params={"query": query, "format": "json"})
        resp.raise_for_status()
        return resp.json()


@register_connector
class WikidataConnector(BaseConnector):
    source_id = "wikidata"

    async def fetch(self, entity_name: str, entity_type: str) -> Dict[str, Any]:
        # Step 1: find QID
        search_data = await _sparql(_ENTITY_SEARCH_QUERY.format(name=entity_name.replace('"', "")))
        bindings = search_data.get("results", {}).get("bindings", [])
        if not bindings:
            return {"_api_url": _SPARQL_URL, "_empty": True, "entity_name": entity_name}

        qid_url = bindings[0]["item"]["value"]  # e.g. http://www.wikidata.org/entity/Q37379
        description = bindings[0].get("itemDescription", {}).get("value", "")

        # Step 2: fetch properties using type-appropriate query
        if entity_type == "movie":
            prop_query = _FILM_PROPERTIES_QUERY.format(qid=qid_url)
        elif entity_type in ("person", "artist", "actor", "director"):
            prop_query = _PERSON_PROPERTIES_QUERY.format(qid=qid_url)
        else:
            prop_query = _GENERIC_QUERY.format(qid=qid_url)

        prop_data = await _sparql(prop_query)

        return {
            "_api_url": _SPARQL_URL,
            "_entity_name": entity_name,
            "_entity_type": entity_type,
            "_qid": qid_url,
            "_description": description,
            "properties": prop_data.get("results", {}).get("bindings", []),
        }

    def parse(self, raw: Dict[str, Any], entity_name: str, entity_type: str, api_url: str) -> List[KnowledgeTriple]:
        if raw.get("_empty"):
            return []

        triples: List[KnowledgeTriple] = []

        # Map Wikidata property labels → our predicate names
        _PREDICATE_MAP = {
            "director": "directed_by",
            "publication date": "released_on",
            "genre": "has_genre",
            "country of origin": "produced_in",
            "producer": "produced_by",
            "IMDb ID": "has_imdb_id",
            "duration": "has_duration_minutes",
            "date of birth": "born_on",
            "date of death": "died_on",
            "place of birth": "born_in",
            "country of citizenship": "citizen_of",
            "occupation": "has_occupation",
            "instance of": "is_instance_of",
            "country": "located_in_country",
            "inception": "founded_on",
            "manufacturer": "manufactured_by",
            "MusicBrainz artist ID": "has_musicbrainz_id",
        }

        qid = raw.get("_qid", "").split("/")[-1]
        if qid:
            triples.append(self._make_triple(
                entity_name, "has_wikidata_id", qid, api_url, raw, object_type="Identifier"
            ))
        if raw.get("_description"):
            triples.append(self._make_triple(
                entity_name, "has_description", raw["_description"][:200], api_url, raw
            ))

        for binding in raw.get("properties", []):
            prop_label = binding.get("propLabel", {}).get("value", "")
            value_label = binding.get("valueLabel", {}).get("value", "")
            if not prop_label or not value_label:
                continue
            predicate = _PREDICATE_MAP.get(prop_label, f"wikidata_{prop_label.lower().replace(' ', '_')}")
            triples.append(self._make_triple(entity_name, predicate, value_label, api_url, raw))

        return triples
