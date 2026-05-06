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
from typing import List, Dict, Any, Optional, AsyncGenerator, Tuple, Callable

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
            timeout=httpx.Timeout(300.0, connect=10.0),
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

Return ONLY an XML block representing the triples, like this:
<triples>
  <triple>
    <subject>Dopamine</subject>
    <subject_type>Biology</subject_type>
    <predicate>drives</predicate>
    <object>reward-seeking behavior</object>
    <object_type>Concept</object_type>
    <citation>Dopamine is responsible for...</citation>
    <confidence>0.95</confidence>
  </triple>
</triples>

TEXT:
{text}

XML TRIPLES:"""


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

Output ONLY an XML block of triples. Example format:
<triples>
  <triple>
    <subject>Dopamine</subject>
    <subject_type>Biology</subject_type>
    <predicate>drives</predicate>
    <object>Reward-Seeking Behavior</object>
    <object_type>Concept</object_type>
    <citation>Dopamine is responsible for the reward-seeking loop in mammalian brains.</citation>
    <confidence>0.9</confidence>
  </triple>
  <triple>
    <subject>Prefrontal Cortex</subject>
    <subject_type>Biology</subject_type>
    <predicate>modulates</predicate>
    <object>impulse control</object>
    <object_type>Process</object_type>
    <citation>The prefrontal cortex acts as a top-down modulator for impulsive actions.</citation>
    <confidence>0.85</confidence>
  </triple>
</triples>

XML:"""


CONFLICT_DETECTION_PROMPT = """You are a logical consistency checker.
Given the following set of knowledge triples already in the graph, and a NEW set of triples about to be added, identify any CONFLICTS (contradictions) between the existing and new triples.

A conflict exists when:
- Two triples make opposing claims about the same subject-object pair
- A new triple directly contradicts an existing one

EXISTING TRIPLES:
{existing}

NEW TRIPLES:
{new_triples}

Return an XML block of conflicts. If no conflicts, return <conflicts></conflicts>.
Each conflict object should have <concept_a>, <concept_b>, and <description>.

Example:
<conflicts>
  <conflict>
    <concept_a>A</concept_a>
    <concept_b>B</concept_b>
    <description>Contradiction explanation...</description>
  </conflict>
</conflicts>

XML CONFLICTS:"""


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

Return an XML block of analogies. If no analogies found, return <analogies></analogies>.
Each analogy should use the tags <concept_a>, <concept_b>, <description>, and <pattern>.

Example:
<analogies>
  <analogy>
    <concept_a>A</concept_a>
    <concept_b>B</concept_b>
    <description>Analogy explanation...</description>
    <pattern>Pattern Name</pattern>
  </analogy>
</analogies>

XML ANALOGIES:"""


CROSS_DOMAIN_PROMPT = """You are a cross-domain analogy engine.
Given the concept "{concept}" and its relationships below, explain how this concept
maps to the domain of "{target_domain}".

CONCEPT RELATIONSHIPS:
{relationships}

Provide:
1. The analogous concept in {target_domain}
2. How the structural pattern maps
3. Key similarities and differences

Be specific and insightful. Format as XML:
<analogy>
  <analogous_concept>...</analogous_concept>
  <mapping>...</mapping>
  <similarities>...</similarities>
  <differences>...</differences>
</analogy>

XML:"""


COMMUNITY_NAMING_PROMPT = """You are a topological expert.
Given the following list of concepts and relationships discovered in a specific "Semantic Neighborhood" (community) of a knowledge graph, provide a concise, descriptive name for this community.

COMMUNITY CONCEPTS:
{concepts}

GUIDELINES:
1. The name should be exactly 2-4 words.
2. It should capture the "essence" of the cluster (e.g., "Neural Execution Layer", "User Data Governance", "Asynchronous Messaging Patterns").
3. Avoid generic names like "Group 1" or "System Cluster".

Return ONLY an XML block:
<community>
  <community_name>...</community_name>
  <justification>...</justification>
</community>

XML:"""



# =============================================================================
# ADAPTIVE CHUNKING
# =============================================================================

def estimate_tokens(text: str) -> int:
    """Estimate token count from character length (~4 chars per token)."""
    return max(1, len(text) // 4)


def adaptive_truncate(text: str, max_tokens: int = 4000) -> str:
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
    workspace: Optional[str] = None,
    role: str = "default"
) -> str:
    """
    Consolidated LLM call with retry and exponential backoff.
    Utilizes the core dispatcher for OpenAI, LiteLLM, and LiteRT.
    """
    cfg = config or SynthesisConfig()

    # Priority 1: Use explicitly provided model
    # Priority 2: Auto-resolve via active workspace manifest OR swarm manifest
    if not model and (workspace or run_id):
        try:
            from ..core.models import get_active_model
            model = await get_active_model(workspace or "default", role=role, run_id=run_id)
        except Exception:
            pass

    # Resolve model string (e.g., "ollama/llama3")
    if model and "/" in model:
        full_model = model
    elif model:
        full_model = f"{provider}/{model}"
    else:
        # Final safety fallback: use provider/default and let executor resolve
        full_model = f"{provider}/default"

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
                logger.error("LLM call failed after %d attempts for role '%s': %s", cfg.max_retries, role, last_error)
                if run_id:
                     from ..core.task_manager import task_manager
                     task_manager.add_aer_entry(run_id, intent=f"LLM Call ({role})", observation="Final retry failed", inference=str(last_error))

    raise last_error


# =============================================================================
# ROBUST JSON PARSING
# =============================================================================

def _parse_json_from_llm(text: str) -> Tuple[Any, str]:
    """
    Robustly extract JSON from LLM output that may contain markdown fences,
    <think> reasoning blocks, or truncated arrays.
    Returns (parsed_data, thinking_string).
    """
    thinking = ""
    # Extract and strip all think blocks
    cleaned = text
    think_blocks = re.findall(r'<think>(.*?)</think>', cleaned, re.DOTALL)
    if think_blocks:
        thinking = "\n---\n".join([t.strip() for t in think_blocks])
        cleaned = re.sub(r'<think>.*?</think>', '', cleaned, flags=re.DOTALL).strip()
    else:
        # Fallback for unclosed think block
        think_match = re.search(r'<think>(.*)', cleaned, re.DOTALL)
        if think_match:
            thinking = think_match.group(1).strip()
            cleaned = re.sub(r'<think>.*', '', cleaned, flags=re.DOTALL).strip()

    # Strip markdown code fences (more robustly)
    if "```" in cleaned:
        # Try to find content inside ```json ... ``` or just ``` ... ```
        fence_matches = re.findall(r"```(?:json)?\s*\n?(.*?)\n?```", cleaned, re.DOTALL)
        if fence_matches:
            # If multiple code blocks, join them or pick the largest?
            # Usually we want the largest or the first one that is valid.
            # We'll try to process the whole thing below anyway.
            pass
        else:
            # Fallback: just strip all lines starting with ```
            lines = cleaned.split("\n")
            lines = [l for l in lines if not l.strip().startswith("```")]
            cleaned = "\n".join(lines).strip()
    
    # ---------------------------------------------------------
    # NEW: Indestructible XML Parsing for Rigid Operating Model
    # ---------------------------------------------------------
    # If the prompt used XML tags (e.g. <triples>), we parse it via regex to avoid strict syntax errors.
    xml_data = []
    
    # 1. Triples
    if "<triple>" in cleaned:
        for triple_match in re.finditer(r'<triple>(.*?)</triple>', cleaned, re.IGNORECASE | re.DOTALL):
            t_str = triple_match.group(1)
            triple = {}
            for tag in ["subject", "subject_type", "predicate", "object", "object_type", "citation", "confidence"]:
                m = re.search(fr'<{tag}>(.*?)</{tag}>', t_str, re.IGNORECASE | re.DOTALL)
                if m:
                    val = m.group(1).strip()
                    if tag == "confidence":
                        try: val = float(val)
                        except: val = 1.0
                    triple[tag] = val
            if "subject" in triple and "object" in triple:
                xml_data.append(triple)
        if xml_data: return xml_data, thinking

    # 2. Conflicts / Analogies (generic list of objects)
    for root_tag, item_tag in [("conflicts", "conflict"), ("analogies", "analogy")]:
        if f"<{item_tag}>" in cleaned:
            for match in re.finditer(fr'<{item_tag}>(.*?)</{item_tag}>', cleaned, re.IGNORECASE | re.DOTALL):
                i_str = match.group(1)
                item = {}
                # Extract any child tags generically
                for tag_match in re.finditer(r'<([a-zA-Z0-9_]+)>(.*?)</\1>', i_str, re.DOTALL):
                    item[tag_match.group(1).lower()] = tag_match.group(2).strip()
                if item: xml_data.append(item)
            if xml_data: return xml_data, thinking
            
    # 3. Community (single object)
    if "<community_name>" in cleaned:
        comm = {}
        for tag in ["community_name", "justification", "analogous_concept", "mapping"]:
            m = re.search(fr'<{tag}>(.*?)</{tag}>', cleaned, re.IGNORECASE | re.DOTALL)
            if m: comm[tag] = m.group(1).strip()
        if comm: return comm, thinking

    # ---------------------------------------------------------
    # JSON Parsing Fallback
    # ---------------------------------------------------------
    def score_json(data: Any) -> int:
        """Score JSON based on its complexity/usefulness."""
        if isinstance(data, list):
            # Bonus for lists as we usually expect arrays of triples
            return len(data) * 10 + 5
        if isinstance(data, dict):
            return len(data.keys())
        return 0

    best_data = []
    max_score = -1

    # Try parsing the whole thing first
    try:
        data = json.loads(cleaned)
        max_score = score_json(data)
        best_data = data
    except:
        pass

    # Find all possible start positions for JSON objects or arrays
    for match in re.finditer(r"\{|\[", cleaned):
        start_idx = match.start()
        start_char = cleaned[start_idx]
        end_char = "}" if start_char == "{" else "]"
        
        # Look for the last occurrence of the matching end bracket
        # and work backwards to find the largest valid JSON.
        end_matches = list(re.finditer(re.escape(end_char), cleaned[start_idx:]))
        for end_match in reversed(end_matches):
            current_end_idx = start_idx + end_match.end()
            json_str = cleaned[start_idx:current_end_idx]
            
            # Clean up trailing commas
            json_str = re.sub(r',\s*([\]}])', r'\1', json_str)
            
            try:
                data = json.loads(json_str)
                score = score_json(data)
                if score > max_score: 
                    max_score = score
                    best_data = data
            except:
                continue

    # Final fallback for truncated JSON
    if max_score <= 5: # If we only found empty lists or dicts, try harder
        first_start = re.search(r"\{|\[", cleaned)
        if first_start:
            start_idx = first_start.start()
            json_str = cleaned[start_idx:]
            
            # Very aggressive truncation recovery: try adding combinations of closing brackets
            for i in range(1, 6):
                for trial_suffix in ["}", "]", "}]", "]}", "}}] ", "}]}]"]:
                    trial = json_str + (trial_suffix * i)
                    try:
                        trial_clean = re.sub(r',\s*([\]}])', r'\1', trial)
                        data = json.loads(trial_clean)
                        score = score_json(data)
                        if score > max_score:
                            max_score = score
                            best_data = data
                    except:
                        continue

    if max_score > -1:
        return best_data, thinking
        
    logger.warning("Failed to parse JSON from LLM output (%d chars).", len(text))
    # DEBUG: Save failed output to a file for inspection
    try:
        debug_path = os.path.join(os.getcwd(), f"failed_llm_output_{int(asyncio.get_event_loop().time())}.txt")
        with open(debug_path, "w", encoding="utf-8") as f:
            f.write(text)
        logger.info("Saved failed LLM output to %s", debug_path)
    except:
        pass
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
    strategy: str = "safe",
    timeout: Optional[float] = None
) -> List[KnowledgeTriple]:
    """
    Extract knowledge triples from text using the configured LLM.
    Uses adaptive chunking instead of hardcoded truncation.
    """
    cfg = config or SynthesisConfig()
    
    # Use adaptive chunking to fit the model's context window
    safe_text = adaptive_truncate(text, cfg.max_context_tokens)
    prompt = TRIPLE_EXTRACTION_PROMPT.format(text=safe_text)

    try:
        # Resolve model_id to track provenance
        from ..core.models import get_active_model
        resolved_model = await get_active_model(workspace)

        # Pass workspace and role to ensure manifest-level model selection
        raw = await call_llm(prompt, run_id=run_id, workspace=workspace, config=cfg, role="graph_synthesis", timeout=timeout)
        
        # Robustly parse JSON and capture any reasoning/thinking blocks
        triples_data, thinking = _parse_json_from_llm(raw)
        
        if thinking and run_id:
             from ..core.task_manager import task_manager
             task_manager.add_aer_entry(run_id, intent=f"Synthesis extraction for {source_name}", observation="Reasoning detected", inference=thinking)

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
        run_id=run_id,
        role="graph_synthesis"
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
    parallel_limit: Optional[int] = None,
    inference_delay: float = 0.5,
    timeout: Optional[float] = None,
    config: Optional[SynthesisConfig] = None,
    event_callback: Optional[Callable] = None,
    workspace: str = "default",
    run_id: Optional[str] = None,
    **kwargs
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
                run_id=run_id,
                workspace=workspace
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
    workspace: str = "default",
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
        raw = await call_llm(prompt, provider=provider, model=model, timeout=timeout, config=cfg, workspace=workspace, run_id=run_id)

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
    workspace: str = "default",
    provider: str = "lemonade",
    model: str = None,
    timeout: Optional[float] = None,
    config: Optional[SynthesisConfig] = None,
    run_id: Optional[str] = None
) -> List[Dict[str, str]]:

    """Find structural isomorphisms in the knowledge graph."""
    cfg = config or SynthesisConfig()
    prompt = SYNTHESIS_PROMPT.format(graph_summary=graph_summary)

    raw = await call_llm(prompt, provider=provider, model=model, timeout=timeout, config=cfg, workspace=workspace, run_id=run_id)

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
    workspace: str = "default",
    provider: str = "lemonade",
    model: str = None,
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

    raw = await call_llm(prompt, provider=provider, model=model, timeout=timeout, config=cfg, workspace=workspace, run_id=run_id)

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

async def get_embedding(
    text: str, 
    provider: str = "local", 
    model: str = None,
    workspace: Optional[str] = None,
    role: str = "graph_synthesis"
) -> List[float]:
    """
    Get a vector embedding for text using either a local or cloud provider.
    
    Providers:
        - "local" / "ollama": Uses ollama's embedding endpoint
        - "openai": Uses OpenAI text-embedding-3-small
    """
    if provider == "openai":
        return await _get_openai_embedding(text, model or "text-embedding-3-small")
    
    # Resolve 'local' to the actual active provider if possible
    if provider == "local":
        try:
            from ..core.models import get_active_model
            active_id = await get_active_model(workspace_id=workspace or "default", role="graph_synthesis")
            if "/" in active_id:
                provider = active_id.split("/")[0]
            else:
                provider = "lemonade" # Default fallback for local
        except Exception as e:
            provider = "ollama" # Final fallback

    if provider == "ollama":
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
    try:
        response = await client.post(url, json={"model": model_name, "input": text})
        if response.status_code == 200:
            data = response.json()
            return data["data"][0]["embedding"]
        else:
            logger.warning(f"{provider} embedding failed ({response.status_code}): {response.text}")
            return [0.0] * 768
    except Exception as e:
        logger.error(f"Failed to connect to {provider} embedding endpoint: {e}")
        return [0.0] * 768


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
    batch_size: int = 16,
    event_callback: Optional[Any] = None,
    workspace: Optional[str] = None
) -> Dict[str, List[float]]:
    """
    Embed multiple concepts concurrently with database-backed caching.
    
    Logic:
    1. Check Neo4j for existing embeddings for these concepts in this workspace.
    2. Only send missing ones to the LLM provider.
    3. Save newly generated embeddings back to Neo4j.
    """
    from ..core.graph_db import read_session, write_session
    
    results: Dict[str, List[float]] = {}
    missing_concepts: List[str] = []
    
    # 1. Check Cache (Neo4j)
    if workspace:
        logger.info("Embedding Cache: checking Neo4j for %d existing vectors...", len(concepts))
        with read_session() as session:
            # We check both Concepts (by name) and CodeEntities (by name: summary)
            # This is a broad check for anything in the workspace with an embedding.
            query = """
            MATCH (n {workspace: $ws})
            WHERE n.embedding IS NOT NULL AND (n.name IN $names OR (n.name + ': ' + coalesce(n.summary, '')) IN $names)
            RETURN n.name as name, n.summary as summary, n.embedding as embedding
            """
            cache_res = session.run(query, ws=workspace, names=concepts)
            for rec in cache_res:
                key = rec["name"]
                # Match the 'name: summary' format used in correlation
                if rec["summary"] and f"{rec['name']}: {rec['summary']}" in concepts:
                    key = f"{rec['name']}: {rec['summary']}"
                results[key] = rec["embedding"]
        
        logger.info("Embedding Cache: found %d/%d vectors in Neo4j", len(results), len(concepts))

    missing_concepts = [c for c in concepts if c not in results]
    if not missing_concepts:
        return results

    # 2. Embed Missing via LLM
    logger.info("Embedding: sending %d missing items to %s provider...", len(missing_concepts), provider)
    semaphore = asyncio.Semaphore(batch_size)
    total = len(missing_concepts)
    completed = 0

    async def embed_one(concept: str):
        nonlocal completed
        async with semaphore:
            try:
                embedding = await get_embedding(concept, provider=provider, model=model, workspace=workspace)
                results[concept] = embedding
                completed += 1
                if event_callback:
                    await event_callback(IngestionEvent(
                        event=IngestionEventType.SECTION_PROGRESS,
                        message=f"Embedded {completed}/{total} new items",
                        data={"current": completed, "total": total}
                    ))
                
                # 3. Save back to Neo4j (Async/Background)
                if workspace:
                    # We determine if it's a Concept or CodeEntity by splitting
                    is_symbol = ": " in concept
                    name = concept.split(": ")[0] if is_symbol else concept
                    summary = concept.split(": ")[1] if is_symbol else None
                    
                    with write_session() as w_session:
                        save_query = """
                        MATCH (n {workspace: $ws, name: $name})
                        WHERE ($summary IS NULL OR n.summary = $summary)
                        SET n.embedding = $embedding
                        """
                        w_session.run(save_query, ws=workspace, name=name, summary=summary, embedding=embedding)
                        
            except Exception as e:
                logger.error(f"Failed to embed '{concept[:30]}...': {e}")
                results[concept] = [0.0] * 768

    tasks = [embed_one(c) for c in missing_concepts]
    await asyncio.gather(*tasks)
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
