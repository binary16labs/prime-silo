"""
Synthesis Engine - LLM-powered triple extraction, embedding, and structural synthesis.

This module contains the three "Logic Layers":
  A. Relational Graph (NER + Relation Extraction -> triples)
  B. Conceptual Cluster (Dual-model embedding -> Venn clustering)
  C. Synthesis Layer (Structural Isomorphism detection)
"""

import asyncio
import json
import logging
import os
import re
from typing import List, Dict, Any, Optional, AsyncGenerator, Tuple

import httpx

from ..core.models import LOCAL_PROVIDERS, call_model
from ..core.schema import KnowledgeTriple, SynthesisConfig, IngestionEvent, IngestionEventType

logger = logging.getLogger(__name__)

# Module-level shared httpx client for connection reuse
_shared_client: Optional[httpx.AsyncClient] = None


def _get_shared_client() -> httpx.AsyncClient:
    """Get or create a shared httpx client with connection pooling."""
    global _shared_client
    if _shared_client is None or _shared_client.is_closed:
        _shared_client = httpx.AsyncClient(
            timeout=httpx.Timeout(120.0, connect=10.0),
            limits=httpx.Limits(max_connections=20, max_keepalive_connections=10)
        )
    return _shared_client


# =============================================================================
# A. RELATIONAL GRAPH - Triple Extraction via LLM
# =============================================================================

TRIPLE_EXTRACTION_PROMPT = """You are a knowledge graph extraction engine.
Given the following text, extract ALL meaningful knowledge triples in the form:
  (Subject, Predicate, Object)

Rules:
- Subject and Object should be concise noun phrases (concepts, entities, processes).
- Predicate should be a verb phrase describing the relationship.
- Extract as many triples as you can find. Be thorough.
- CROSS-LINKING: If the text describes a design decision, architecture, or pattern, try to link it to potential code symbols or files (e.g., "AuthenticationService", "schema.py").
- If the text mentions a source document name, include triples that reference it.

Return ONLY a JSON array of objects, like:
[
  {{
    "subject": "Dopamine",
    "subject_type": "Biology",
    "predicate": "drives",
    "object": "reward-seeking behavior",
    "object_type": "Concept",
    "citation": "Dopamine is responsible for...",
    "confidence": 0.95
  }}
]

TEXT:
{text}

JSON TRIPLES:"""


DIRECTED_EXTRACTION_PROMPT = """You are an L2 expert reading a specific section of a document.
Your goal is to extract ALL core points, arguments, or mechanisms made in this section.

{direction_prompt}

Rules for Extraction:
1. Extract as many meaningful triples as you can find. Be thorough.
2. Filter out any noise; only extract points structurally relevant to the direction (if provided).
3. "subject_type" and "object_type" should categorize the entity (e.g., Person, Theory, Technology, Organization, Location, Event, Concept).
4. "citation" must be the exact short sentence/excerpt from the text that justifies the claim.
5. "confidence" should be a score from 0.0 to 1.0 (1.0 = proven/stated as fact, 0.5 = hypothesized).

TEXT SECTION: {section_title}
{text}

Output ONLY a JSON array of objects. Example format:
[
  {{
    "subject": "Dopamine",
    "subject_type": "Biology",
    "predicate": "drives",
    "object": "Reward-Seeking Behavior",
    "object_type": "Concept",
    "citation": "Dopamine is responsible for the reward-seeking loop in mammalian brains.",
    "confidence": 0.9
  }},
  {{
    "subject": "Prefrontal Cortex",
    "subject_type": "Biology",
    "predicate": "modulates",
    "object": "impulse control",
    "object_type": "Process",
    "citation": "The prefrontal cortex acts as a top-down modulator for impulsive actions.",
    "confidence": 0.85
  }}
]

JSON:"""


CONFLICT_DETECTION_PROMPT = """You are a logical consistency checker.
Given the following set of knowledge triples already in the graph, and a NEW set of triples about to be added, identify any CONFLICTS (contradictions) between the existing and new triples.

A conflict exists when:
- Two triples make opposing claims about the same subject-object pair
- A new triple directly contradicts an existing one

EXISTING TRIPLES:
{existing}

NEW TRIPLES:
{new_triples}

Return a JSON array of conflict objects. If no conflicts, return [].
Each conflict object should have:
  "concept_a": the first concept involved,
  "concept_b": the second concept involved,
  "description": a brief explanation of the contradiction

JSON CONFLICTS:"""


SYNTHESIS_PROMPT = """You are a cross-domain synthesis engine that finds structural isomorphisms -
patterns that repeat across different fields.

Given the following set of concepts and their relationships, identify any
STRUCTURAL ANALOGIES (isomorphisms) between concepts from different domains.

An analogy exists when:
- Two systems from different fields share the same underlying pattern or structure
- The way one system works is mathematically or structurally similar to another
- E.g. how a forest fire spreads (Biology) is similar to how a viral tweet spreads (Sociology)

KNOWLEDGE GRAPH:
{graph_summary}

Return a JSON array of analogy objects. If no analogies found, return [].
Each analogy object should have:
  "concept_a": first concept,
  "concept_b": second concept,
  "description": explanation of the analogy,
  "pattern": the shared abstract pattern name (e.g. "Resilience through Redundancy")

JSON ANALOGIES:"""


CROSS_DOMAIN_PROMPT = """You are a cross-domain analogy engine.
Given the concept "{concept}" and its relationships below, explain how this concept
maps to the domain of "{target_domain}".

CONCEPT RELATIONSHIPS:
{relationships}

Provide:
1. The analogous concept in {target_domain}
2. How the structural pattern maps
3. Key similarities and differences

Be specific and insightful. Format as JSON:
{{
  "analogous_concept": "...",
  "mapping": "...",
  "similarities": ["..."],
  "differences": ["..."]
}}

JSON:"""


COMMUNITY_NAMING_PROMPT = """You are a topological expert.
Given the following list of concepts and relationships discovered in a specific "Semantic Neighborhood" (community) of a knowledge graph, provide a concise, descriptive name for this community.

COMMUNITY CONCEPTS:
{concepts}

GUIDELINES:
1. The name should be exactly 2-4 words.
2. It should capture the "essence" of the cluster (e.g., "Neural Execution Layer", "User Data Governance", "Asynchronous Messaging Patterns").
3. Avoid generic names like "Group 1" or "System Cluster".

Return ONLY a JSON object:
{{
  "community_name": "...",
  "justification": "..."
}}

JSON:"""



# =============================================================================
# ADAPTIVE CHUNKING
# =============================================================================

def estimate_tokens(text: str) -> int:
    """Estimate token count from character length (~4 chars per token)."""
    return max(1, len(text) // 4)


def adaptive_truncate(text: str, max_tokens: int = 1500) -> str:
    """
    Truncate text to fit within a token budget, preferring to break at
    sentence boundaries rather than mid-sentence.
    """
    max_chars = max_tokens * 4
    if len(text) <= max_chars:
        return text

    # Try to break at the last sentence boundary within the budget
    truncated = text[:max_chars]
    last_period = truncated.rfind('. ')
    last_newline = truncated.rfind('\n')
    break_at = max(last_period, last_newline)

    if break_at > max_chars * 0.6:  # Only break at boundary if we keep >60% of content
        return truncated[:break_at + 1]
    return truncated


# =============================================================================
# LLM CALL WITH RETRY
# =============================================================================

async def call_llm(
    prompt: str,
    provider: str = "lemonade",
    model: Optional[str] = None,
    timeout: Optional[float] = None,
    config: Optional[SynthesisConfig] = None,
    run_id: Optional[str] = None,
    workspace: Optional[str] = None
) -> str:
    """
    Consolidated LLM call with retry and exponential backoff.
    Utilizes the core dispatcher for OpenAI, LiteLLM, and LiteRT.
    """
    cfg = config or SynthesisConfig()

    # Priority 1: Use explicitly provided model
    # Priority 2: Auto-resolve via active workspace manifest
    # Priority 3: Fallback defaults
    if not model and workspace:
        try:
            from ..core.models import get_active_model
            model = await get_active_model(workspace)
        except Exception:
            pass

    # Resolve model string (e.g., "ollama/llama3")
    if model and "/" in model:
        full_model = model
    else:
        # Fallback to default model names for known providers
        default_models = {
            "ollama": "ollama/llama3",
            "lemonade": "lemonade/deepseek-r1-8b-FLM",
            "fastflowlm": "fastflowlm/gemma3:4b",
            "litert": "litert/gemma-4-E4B-it.litertlm"
        }
        if model:
            full_model = f"{provider}/{model}"
        else:
            full_model = default_models.get(provider, "lemonade/default")

    last_error = None
    for attempt in range(cfg.max_retries):
        try:
            return await call_model(
                model=full_model,
                messages=[{"role": "user", "content": prompt}],
                temperature=0.3,
                timeout=timeout,
                run_id=run_id
            )
        except Exception as e:
            last_error = e
            if attempt < cfg.max_retries - 1:
                delay = cfg.retry_base_delay * (2 ** attempt)
                logger.warning(
                    "LLM call attempt %d/%d failed (%s). Retrying in %.1fs...",
                    attempt + 1, cfg.max_retries, str(e)[:100], delay
                )
                await asyncio.sleep(delay)
            else:
                logger.error("LLM call failed after %d attempts: %s", cfg.max_retries, e)

    raise last_error


# =============================================================================
# ROBUST JSON PARSING
# =============================================================================

def _parse_json_from_llm(text: str) -> Tuple[Any, str]:
    """
    Robustly extract JSON from LLM output that may contain markdown fences,
    <think> reasoning blocks, or truncated arrays.
    Now returns (parsed_data, thinking_string).
    """
    thinking = ""
    # Extract think blocks (common in DeepSeek-R1 and similar reasoning models)
    think_match = re.search(r'<think>(.*?)(?:</think>|$)', text, re.DOTALL)
    if think_match:
        thinking = think_match.group(1).strip()
    
    # Strip think blocks for JSON cleaning
    cleaned = re.sub(r'<think>.*?</think>', '', text, flags=re.DOTALL).strip()

    # Strip markdown code fences
    if cleaned.startswith("```"):
        lines = cleaned.split("\n")
        lines = [l for l in lines if not l.strip().startswith("```")]
        cleaned = "\n".join(lines).strip()
    
    # Find JSON boundaries
    start_char = ""
    start_idx = -1
    for i, char in enumerate(cleaned):
        if char in "{[":
            start_idx = i
            start_char = char
            break
            
    if start_idx == -1:
        # Fallback to older logic if no brackets found
        try:
            return json.loads(cleaned), thinking
        except:
             return [], thinking

    # Find last corresponding bracket
    end_char = "}" if start_char == "{" else "]"
    end_idx = cleaned.rfind(end_char)
    
    if end_idx != -1:
        json_str = cleaned[start_idx:end_idx + 1]
    else:
        json_str = cleaned[start_idx:]

    # Clean up trailing commas
    json_str = re.sub(r',\s*([\]}])', r'\1', json_str)

    try:
        return json.loads(json_str), thinking
    except json.JSONDecodeError:
        # Simple recovery for truncated arrays/objects
        if not (json_str.endswith("}") or json_str.endswith("]")):
            # Naive close
            if start_char == "{": json_str += "}"
            else: json_str += "]"
            try:
                return json.loads(json_str), thinking
            except:
                pass
        
        logger.warning("Failed to parse JSON from LLM output (%d chars).", len(text))
        return [], thinking


# =============================================================================
# DEDUPLICATION & QUALITY FILTERING
# =============================================================================

def deduplicate_triples(triples: List[KnowledgeTriple]) -> List[KnowledgeTriple]:
    """Remove near-duplicate triples using normalized subject|predicate|object keys."""
    seen = set()
    unique = []
    for t in triples:
        key = t.normalized_key
        if key not in seen:
            seen.add(key)
            unique.append(t)
        else:
            logger.debug("Deduplicated triple: %s", key)
    if len(triples) != len(unique):
        logger.info("Deduplication: %d -> %d triples (removed %d duplicates)",
                     len(triples), len(unique), len(triples) - len(unique))
    return unique


def filter_by_confidence(triples: List[KnowledgeTriple], min_confidence: float = 0.3) -> List[KnowledgeTriple]:
    """Discard low-confidence triples below the threshold."""
    filtered = [t for t in triples if t.confidence >= min_confidence]
    removed = len(triples) - len(filtered)
    if removed:
        logger.info("Confidence filter: removed %d low-confidence triples (threshold=%.2f)",
                     removed, min_confidence)
    return filtered


def _validate_and_convert_triples(
    raw_triples: Any,
    section_title: str = "",
    config: Optional[SynthesisConfig] = None,
    model_id: str = "unknown",
    strategy: str = "safe"
) -> List[KnowledgeTriple]:
    """Convert raw LLM JSON output into validated KnowledgeTriple models."""
    cfg = config or SynthesisConfig()

    if not isinstance(raw_triples, list):
        return []

    valid = []
    for t in raw_triples:
        if isinstance(t, dict) and "subject" in t and "predicate" in t and "object" in t:
            try:
                triple = KnowledgeTriple(
                    subject=t.get("subject", ""),
                    subject_type=t.get("subject_type", "Concept"),
                    predicate=t.get("predicate", ""),
                    object=t.get("object", ""),
                    object_type=t.get("object_type", "Concept"),
                    citation=t.get("citation", ""),
                    confidence=float(t.get("confidence", 1.0)),
                    section_title=section_title or t.get("section_title", ""),
                    model_id=model_id,
                    strategy=strategy
                )
                valid.append(triple)
            except Exception as e:
                logger.debug("Skipping invalid triple: %s", e)

    # Apply confidence filter
    valid = filter_by_confidence(valid, cfg.min_confidence)

    return valid


# =============================================================================
# TRIPLE EXTRACTION
# =============================================================================

async def extract_triples(
    text: str,
    source_name: str = "unknown",
    run_id: Optional[str] = None,
    workspace: Optional[str] = "default",
    config: Optional[SynthesisConfig] = None,
    strategy: str = "safe"
) -> List[KnowledgeTriple]:
    """
    Extract knowledge triples from text using the configured LLM.
    Uses adaptive chunking instead of hardcoded truncation.
    """
    cfg = config or SynthesisConfig()
    
    # Choose prompt
    prompt = TRIPLE_EXTRACTION_PROMPT.format(text=text[:10000]) # Adaptive limit for safety

    try:
        # Resolve model_id to track provenance
        from ..core.models import get_active_model
        resolved_model = await get_active_model(workspace)

        # Pass workspace to ensure manifest-level model selection
        raw = await call_llm(prompt, run_id=run_id, workspace=workspace, config=cfg)
        
        # Simple extraction of JSON block from LLM output
        json_match = re.search(r'\[.*\]', raw, re.DOTALL)
        if not json_match:
            logger.warning(f"No JSON array found in LLM response for {source_name}")
            return []
            
        triples_data = json.loads(json_match.group(0))
        return _validate_and_convert_triples(
            triples_data, 
            section_title=source_name, 
            config=cfg,
            model_id=resolved_model,
            strategy=strategy
        )
        
    except Exception as e:
        logger.error(f"Extraction failed for {source_name}: {e}")
        return []


async def name_community(
    concepts: List[str],
    workspace: str = "default",
    run_id: Optional[str] = None
) -> Dict[str, str]:
    """
    Generate a concise name and justification for a semantic community.
    """
    prompt = COMMUNITY_NAMING_PROMPT.format(concepts=", ".join(concepts[:50]))
    try:
        raw = await call_llm(prompt, run_id=run_id, workspace=workspace)
        data, thinking = _parse_json_from_llm(raw)
        if isinstance(data, dict) and "community_name" in data:
            return data
        return {"community_name": f"Community {concepts[0][:10]}", "justification": "Fallback name"}
    except Exception as e:
        logger.error(f"Community naming failed: {e}")
        return {"community_name": "Unknown Cluster", "justification": str(e)}


async def extract_directed_triples_from_section(
    text: str,
    section_title: str,
    direction: str = "",
    workspace: str = "default",
    run_id: Optional[str] = None,
    provider: str = "lemonade",
    model: str = None,
    strategy: str = "safe",
    inference_delay: float = 0.5,
    timeout: Optional[float] = None,
    config: Optional[SynthesisConfig] = None
) -> List[KnowledgeTriple]:
    """
    Extract L2 points from a document section, optionally influenced by user direction.
    """
    cfg = config or SynthesisConfig()

    # Optional delay to protect local NPU/CPU from thermal throttling
    actual_delay = inference_delay if inference_delay > 0 else cfg.inference_delay
    if actual_delay > 0:
        await asyncio.sleep(actual_delay)

    safe_text = adaptive_truncate(text, cfg.max_context_tokens)

    dir_prompt = ""
    if direction.strip():
        dir_prompt = f"DIRECTION / INTENT:\nThe user is specifically looking for: '{direction}'. Focus heavily on points that help answer this intent."

    prompt = DIRECTED_EXTRACTION_PROMPT.format(
        direction_prompt=dir_prompt,
        section_title=section_title,
        text=safe_text
    )

    # Resolve model_id to track provenance
    from ..core.models import get_active_model
    resolved_model = await get_active_model(workspace)
    
    raw = await call_llm(
        prompt, 
        provider=provider, 
        model=model or resolved_model, 
        timeout=timeout, 
        config=cfg, 
        run_id=run_id
    )
    
    raw_triples, thinking = _parse_json_from_llm(raw)
    
    if thinking and run_id:
         from ..core.task_manager import task_manager
         task_manager.add_aer_entry(run_id, intent=f"Extracting section: {section_title}", observation="Reasoning detected", inference=thinking)

    return _validate_and_convert_triples(
        raw_triples, 
        section_title=section_title, 
        config=cfg,
        model_id=resolved_model,
        strategy=strategy
    )
 


async def parallel_extract_triples(
    sections: List[Dict[str, str]],
    direction: str = "",
    provider: str = "lemonade",
    model: str = None,
    timeout: Optional[float] = None,
    config: Optional[SynthesisConfig] = None,
    event_callback: Optional[Any] = None,
    run_id: Optional[str] = None
) -> List[KnowledgeTriple]:
    """
    Process multiple document sections in parallel for high-performance ingestion.
    Uses an asyncio.Semaphore to prevent overloading the LLM provider.
    Emits progress events via event_callback if provided.
    """
    cfg = config or SynthesisConfig()
    actual_limit = parallel_limit or cfg.parallel_limit
    semaphore = asyncio.Semaphore(actual_limit)
    total = len(sections)

    async def wrapped_extract(idx: int, section: Dict[str, str]):
        async with semaphore:
            logger.info("Extracting section %d/%d: %s", idx + 1, total, section["title"])
            if event_callback:
                await event_callback(IngestionEvent(
                    event=IngestionEventType.SECTION_PROGRESS,
                    message=f"Processing section {idx + 1}/{total}: {section['title']}",
                    data={"current": idx + 1, "total": total, "section": section["title"]}
                ))
            return await extract_directed_triples_from_section(
                text=section["text"],
                section_title=section["title"],
                direction=direction,
                provider=provider,
                model=model,
                inference_delay=inference_delay,
                timeout=timeout,
                config=cfg,
                run_id=run_id
            )

    # Launch parallel tasks
    tasks = [wrapped_extract(i, section) for i, section in enumerate(sections)]
    results = await asyncio.gather(*tasks, return_exceptions=True)

    # Flatten results, handling exceptions gracefully
    flat_triples: List[KnowledgeTriple] = []
    for i, result in enumerate(results):
        if isinstance(result, Exception):
            logger.error("Section %d extraction failed: %s", i + 1, result)
        elif isinstance(result, list):
            flat_triples.extend(result)

    # Deduplicate across all sections
    if cfg.deduplicate:
        flat_triples = deduplicate_triples(flat_triples)

    if event_callback:
        await event_callback(IngestionEvent(
            event=IngestionEventType.TRIPLES_EXTRACTED,
            message=f"Extraction complete: {len(flat_triples)} triples",
            data={"count": len(flat_triples)}
        ))

    return flat_triples


# =============================================================================
# CONFLICT DETECTION
# =============================================================================

async def detect_conflicts(
    existing_triples: List[Any],
    new_triples: List[Any],
    provider: str = "lemonade",
    model: str = None,
    timeout: Optional[float] = None,
    config: Optional[SynthesisConfig] = None,
    run_id: Optional[str] = None
) -> List[Dict[str, str]]:
    """Detect logical conflicts between existing and new triples."""
    cfg = config or SynthesisConfig()

    if not existing_triples or not new_triples:
        return []

    # Serialize triples for prompt — handle both KnowledgeTriple and raw dicts/lists
    def serialize(triples, limit):
        items = triples[:limit]
        serialized = []
        for t in items:
            if isinstance(t, KnowledgeTriple):
                serialized.append(t.model_dump())
            elif isinstance(t, dict):
                serialized.append(t)
            elif isinstance(t, list) and len(t) >= 3:
                serialized.append({"subject": t[0], "predicate": t[1], "object": t[2]})
        return serialized

    prompt = CONFLICT_DETECTION_PROMPT.format(
        existing=json.dumps(serialize(existing_triples, cfg.max_conflict_triples)),
        new_triples=json.dumps(serialize(new_triples, cfg.max_conflict_triples))
    )

    try:
        raw = await call_llm(prompt, provider=provider, model=model, timeout=timeout, config=cfg, run_id=run_id)
        conflicts, thinking = _parse_json_from_llm(raw)

        if thinking and run_id:
             from ..core.task_manager import task_manager
             task_manager.add_aer_entry(run_id, intent="Detecting conflicts", observation="Reasoning detected", inference=thinking)

        if not isinstance(conflicts, list):
            return []

        return [c for c in conflicts if isinstance(c, dict) and "concept_a" in c]
    except Exception as e:
        logger.warning("Conflict detection bypassed: LLM call failed (%s)", e)
        return []


# =============================================================================
# SYNTHESIS & ANALOGIES
# =============================================================================

async def find_synthesis(
    graph_summary: str,
    provider: str = "lemonade",
    model: str = None,
    timeout: Optional[float] = None,
    config: Optional[SynthesisConfig] = None,
    run_id: Optional[str] = None
) -> List[Dict[str, str]]:
    """Find structural isomorphisms in the knowledge graph."""
    cfg = config or SynthesisConfig()
    prompt = SYNTHESIS_PROMPT.format(graph_summary=graph_summary)

    raw = await call_llm(prompt, provider=provider, model=model, timeout=timeout, config=cfg, run_id=run_id)
    analogies, thinking = _parse_json_from_llm(raw)

    if thinking and run_id:
         from ..core.task_manager import task_manager
         task_manager.add_aer_entry(run_id, intent="Searching for synthesis/analogies", observation="Reasoning detected", inference=thinking)

    if not isinstance(analogies, list):
        return []

    return [a for a in analogies if isinstance(a, dict) and "concept_a" in a]


async def cross_domain_analogy(
    concept: str,
    relationships: str,
    target_domain: str,
    provider: str = "lemonade",
    timeout: Optional[float] = None,
    config: Optional[SynthesisConfig] = None,
    run_id: Optional[str] = None
) -> Dict[str, Any]:
    """Map a concept into a different domain."""
    cfg = config or SynthesisConfig()
    prompt = CROSS_DOMAIN_PROMPT.format(
        concept=concept,
        relationships=relationships,
        target_domain=target_domain
    )

    raw = await call_llm(prompt, provider=provider, model=model, timeout=timeout, config=cfg, run_id=run_id)
    result, thinking = _parse_json_from_llm(raw)

    if thinking and run_id:
         from ..core.task_manager import task_manager
         task_manager.add_aer_entry(run_id, intent=f"Generating cross-domain analogy: {target_domain}", observation="Reasoning detected", inference=thinking)

    if isinstance(result, dict):
        return result
    return {"error": "Could not generate cross-domain analogy", "raw": raw}


# =============================================================================
# B. CONCEPTUAL CLUSTER - Dual-Model Embedding
# =============================================================================

async def get_embedding(text: str, provider: str = "local", model: str = None) -> List[float]:
    """
    Get a vector embedding for text using either a local or cloud provider.
    
    Providers:
        - "local" / "ollama": Uses ollama's embedding endpoint
        - "openai": Uses OpenAI text-embedding-3-small
    """
    if provider == "openai":
        return await _get_openai_embedding(text, model or "text-embedding-3-small")
    elif provider == "ollama" or provider == "local":
        return await _get_ollama_embedding(text, model or "nomic-embed-text")
    else:
        # For 'lemonade', 'fastflowlm', or other OpenAI-compatible local endpoints
        return await _get_generic_local_embedding(text, provider, model)


async def _get_generic_local_embedding(text: str, provider: str, model: str = None) -> List[float]:
    """Get embedding from an OpenAI-compatible local AI endpoint (e.g. Lemonade)."""
    provider_config = LOCAL_PROVIDERS.get(provider)
    if not provider_config:
        raise ValueError(f"Unknown local provider for embedding: {provider}")

    api_base = provider_config["base_url"]
    url = f"{api_base}/embeddings"

    model_name = model.split("/")[-1] if model else "default"

    # FastFlowLM and Lemonade throw errors if a Chat model is passed to the Embeddings endpoint.
    if provider == "lemonade" and model_name == "default":
        model_name = "nomic-embed-text-v1-GGUF"

    client = _get_shared_client()
    response = await client.post(url, json={"model": model_name, "input": text})
    if response.status_code == 200:
        data = response.json()
        return data["data"][0]["embedding"]
    else:
        raise Exception(f"{provider} embedding failed: {response.status_code} {response.text}")


async def _get_ollama_embedding(text: str, model: str = "nomic-embed-text") -> List[float]:
    """Get embedding from Ollama /api/embeddings endpoint."""
    url = "http://localhost:11434/api/embeddings"
    client = _get_shared_client()
    response = await client.post(url, json={"model": model, "prompt": text})
    if response.status_code == 200:
        data = response.json()
        return data.get("embedding", [])
    else:
        raise Exception(f"Ollama embedding failed: {response.status_code}")


async def _get_openai_embedding(text: str, model: str = "text-embedding-3-small") -> List[float]:
    """Get embedding from OpenAI API."""
    import openai
    client_obj = openai.AsyncOpenAI(api_key=os.environ.get("OPENAI_API_KEY", ""))
    response = await client_obj.embeddings.create(input=text, model=model)
    return response.data[0].embedding


async def batch_embed_concepts(
    concepts: List[str],
    provider: str = "local",
    model: str = None,
    batch_size: int = 8,
    event_callback: Optional[Any] = None
) -> Dict[str, List[float]]:
    """
    Embed multiple concepts concurrently with controlled parallelism.
    Returns a dict of concept_name -> embedding vector.
    """
    semaphore = asyncio.Semaphore(batch_size)
    results: Dict[str, List[float]] = {}
    total = len(concepts)
    completed = 0

    async def embed_one(concept: str):
        nonlocal completed
        async with semaphore:
            try:
                emb = await get_embedding(concept, provider=provider, model=model)
                results[concept] = emb
            except Exception as e:
                logger.warning("Embedding failed for '%s': %s", concept, str(e)[:100])
            finally:
                completed += 1
                if event_callback and completed % 10 == 0:
                    await event_callback(IngestionEvent(
                        event=IngestionEventType.EMBEDDING_PROGRESS,
                        message=f"Embedded {completed}/{total} concepts",
                        data={"completed": completed, "total": total}
                    ))

    tasks = [embed_one(concept) for concept in concepts]
    await asyncio.gather(*tasks)

    if event_callback:
        await event_callback(IngestionEvent(
            event=IngestionEventType.EMBEDDING_PROGRESS,
            message=f"Embedding complete: {len(results)}/{total} concepts",
            data={"completed": len(results), "total": total}
        ))

    return results


async def compute_cluster_similarities(
    concepts: List[str],
    workspace: str = "default",
    threshold: float = 0.75
) -> List[Dict[str, Any]]:
    """
    Compute pairwise similarities for a list of concepts using their stored embeddings.
    Returns pairs above the threshold - this powers the "Venn" clustering.
    """
    from ..core.graph_db import get_driver
    from math import sqrt

    driver = get_driver()
    embeddings = {}

    with driver.session() as session:
        for concept in concepts:
            result = session.run("""
                MATCH (c:Concept {name: $name, workspace: $workspace})
                RETURN c.embedding AS embedding
            """, name=concept, workspace=workspace)
            record = result.single()
            if record and record["embedding"]:
                embeddings[concept] = record["embedding"]

    # Pairwise cosine similarity
    def cosine_sim(a, b):
        dot = sum(x * y for x, y in zip(a, b))
        na = sqrt(sum(x * x for x in a))
        nb = sqrt(sum(x * x for x in b))
        return dot / (na * nb) if (na and nb) else 0.0

    clusters = []
    concept_list = list(embeddings.keys())
    for i in range(len(concept_list)):
        for j in range(i + 1, len(concept_list)):
            sim = cosine_sim(embeddings[concept_list[i]], embeddings[concept_list[j]])
            if sim >= threshold:
                clusters.append({
                    "concept_a": concept_list[i],
                    "concept_b": concept_list[j],
                    "similarity": round(sim, 4)
                })

    clusters.sort(key=lambda x: x["similarity"], reverse=True)
    return clusters


# =============================================================================
# C. LIBRARIAN - Synthesis Wiki Persistence (Karpathy-style)
# =============================================================================

async def save_concept_article(
    workspace: str,
    concept_name: str,
    summary: str,
    relationships: List[Dict[str, str]],
    source_files: List[str]
) -> str:
    """
    Generate and save a 'Rationale Hub' article as a Markdown file in .benny/wiki/.
    This creates the permanent 'Compounding Artifact' record.
    """
    from ..core.workspace import get_workspace_path
    
    wiki_path = get_workspace_path(workspace) / ".benny" / "wiki"
    wiki_path.mkdir(parents=True, exist_ok=True)
    
    filename = re.sub(r'[^a-zA-Z0-9]', '_', concept_name) + ".md"
    file_path = wiki_path / filename
    
    # Format relationships for the wiki
    rel_md = "\n".join([f"- **{r['predicate'].title()}**: {r['object']} ({r['object_type']})" for r in relationships])
    sources_md = "\n".join([f"- {s}" for s in source_files])
    
    content = f"""# {concept_name}

## 💡 Rationale Summary
{summary}

## 🔗 Semantic Connections (Knowledge Graph)
{rel_md}

## 📂 Source Context (Lineage)
{sources_md}

---
*Generated by Benny Synthesis Engine. This is a Compounding Rationale Hub.*
"""
    
    with open(file_path, "w", encoding="utf-8") as f:
        f.write(content.strip())
        
    return str(file_path)
