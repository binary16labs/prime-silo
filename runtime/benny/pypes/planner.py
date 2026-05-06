"""LLM-driven Pypes manifest generator.

Mirrors the pattern of ``benny/graph/manifest_runner.plan_from_requirement``
but emits a ``PypesManifest`` (declarative DAG) instead of a swarm DAG.

Design rules
------------
* **Sandbox, not gate.** The generated manifest is a *draft* — the user
  reviews / edits the JSON before approving with ``--run`` or piping it
  into ``benny pypes run``. The planner never auto-executes a pipeline
  it just authored.
* **Always uses ``call_model()``.** Per ``CLAUDE.md`` rule #1 the planner
  must route through the offline-aware dispatcher, never raw LiteLLM.
* **Strict schema prompt.** The system prompt embeds an abridged JSON
  spec of ``PypesManifest`` plus the registered operation list so the
  model has everything it needs to emit a valid manifest in one shot.
* **Validation as a hard gate.** Output is parsed against the Pydantic
  ``PypesManifest`` model — if it fails, we surface the validation
  error so the caller can either retry, edit, or pick a stronger model.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import uuid
from typing import Any, Dict, List, Literal, Optional, Tuple

from pydantic import ValidationError

from .models import PypesManifest
from .registry import default_registry
from ..graph.swarm import parse_json_safe

log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# PROMPT TEMPLATES
# ---------------------------------------------------------------------------

_SYSTEM_PROMPT = """\
You are the Benny Pypes Planner — an expert at translating a plain-English
data-engineering requirement into a strictly-typed `PypesManifest` JSON
document.

A PypesManifest is a declarative, DAG-based transformation contract built on
the bronze -> silver -> gold medallion pattern with full CLP (Conceptual /
Logical / Physical) lineage. Every step is engine-agnostic and is dispatched
through the registered operation set.

# OUTPUT RULES (follow exactly)

1. Respond with **only one JSON object** — no commentary, no markdown fence,
   no leading text. Just the raw JSON for the PypesManifest.
2. The top-level object MUST include all required fields:
   `schema_version` ("1.0"), `kind` ("pypes_pipeline"), `id`, `name`,
   `workspace`, `governance`, `clp`, `steps`. Optional but recommended:
   `description`, `variables`, `reports`, `config`, `tags`.
3. Each step must include `id`, `engine` ("pandas" or "polars"), `stage`
   ("bronze" | "silver" | "gold"), `inputs` (list[str]), `outputs`
   (list[str]), and either `operations` or `sub_manifest_uri`.
4. Bronze steps load raw data and MUST set `source.uri` + `source.format`.
   Use `${data_dir}` (a manifest variable you also declare) — never an
   absolute filesystem path.
5. Step graph rules:
   - The first bronze step's `inputs` MUST be `[]`.
   - Every named upstream output (any string in `inputs`) must be produced
     by some other step's `outputs`.
   - Step ids are unique. Output names are unique across the whole manifest.
6. Add `post_validations` to silver and gold steps where it makes sense
   (`completeness`, `uniqueness`, `thresholds`, `row_count`, `move_analysis`).
7. Always emit at least one Gold step. Add a `reports` array for the user.
8. Use ONLY the registered operations listed below — never invent ones.

# REGISTERED OPERATIONS

{operations}

# REPORT KINDS

financial_risk | threshold_breaches | move_analysis | generic_summary

# MINIMAL TEMPLATE (shape, not content)

{example}
"""


_MINIMAL_EXAMPLE = {
    "schema_version": "1.0",
    "kind": "pypes_pipeline",
    "id": "example-id",
    "name": "Human-readable name",
    "description": "What this pipeline does in one sentence.",
    "workspace": "default",
    "governance": {
        "compliance_tags": ["BCBS-239"],
        "owner": "Risk_Team",
        "criticality": "medium",
        "pii_policy": "block",
    },
    "clp": {
        "conceptual": [{"name": "Trade", "description": "..."}],
        "logical": [
            {
                "entity": "Trade",
                "fields": [
                    {"name": "trade_id", "type": "string", "required": True},
                    {"name": "notional", "type": "float", "required": True},
                ],
            }
        ],
    },
    "variables": {"data_dir": "${benny_home}/data_in"},
    "steps": [
        {
            "id": "bronze_load",
            "stage": "bronze",
            "engine": "pandas",
            "inputs": [],
            "outputs": ["raw_trades"],
            "source": {"uri": "${data_dir}/trades.csv", "format": "csv"},
            "operations": [{"operation": "load", "params": {"source_id": "FRONT_OFFICE"}}],
            "post_validations": {"completeness": ["trade_id"], "uniqueness": ["trade_id"]},
        },
        {
            "id": "silver_clean",
            "stage": "silver",
            "engine": "pandas",
            "inputs": ["raw_trades"],
            "outputs": ["clean_trades"],
            "operations": [
                {"operation": "filter", "params": {"column": "status", "op": "==", "value": "completed"}},
                {"operation": "dedupe", "params": {"subset": ["trade_id"]}},
            ],
        },
        {
            "id": "gold_exposure",
            "stage": "gold",
            "engine": "pandas",
            "inputs": ["clean_trades"],
            "outputs": ["exposure"],
            "operations": [
                {
                    "operation": "aggregate",
                    "params": {
                        "group_by": ["counterparty_id"],
                        "metrics": {"total": "sum(notional)", "trades": "count(trade_id)"},
                    },
                }
            ],
        },
    ],
    "reports": [
        {
            "id": "exposure_report",
            "title": "Counterparty Exposure",
            "kind": "financial_risk",
            "source_step": "gold_exposure",
            "drill_down_by": ["counterparty_id"],
            "metrics": {"total": "sum(total)"},
            "format": "markdown",
            "top_n": 25,
        }
    ],
    "config": {"default_engine": "pandas", "max_concurrency": 2},
    "tags": ["pypes", "demo"],
}


_USER_PROMPT = """\
Requirement:
\"\"\"
{requirement}
\"\"\"

Workspace: `{workspace}`
Manifest id: `{manifest_id}`

Authoring notes:
{notes}

Now emit the PypesManifest as a single JSON object. No prose, no markdown
fence — just the JSON.
"""


# ---------------------------------------------------------------------------
# PUBLIC API
# ---------------------------------------------------------------------------


# Strategy literal — public for type-checkers, validated in the dispatcher.
PlannerStrategy = Literal["auto", "oneshot", "incremental", "swarm"]
_VALID_STRATEGIES = ("auto", "oneshot", "incremental", "swarm")


def plan_pypes_manifest(
    requirement: str,
    *,
    workspace: str = "default",
    model: Optional[str] = None,
    strategy: str = "auto",
    swarm_models: Optional[List[str]] = None,
    judge_model: Optional[str] = None,
    manifest_id: Optional[str] = None,
    extra_notes: Optional[str] = None,
    temperature: float = 0.2,
    max_tokens: int = 8192,
) -> Tuple[PypesManifest, Dict[str, Any]]:
    """Generate (and validate) a ``PypesManifest`` from a plain-English requirement.

    The dispatcher picks one of three planning strategies:

    * ``"oneshot"`` — single LLM call. Fast, but requires a strong model
      (cloud-class or 14B+ local) to reliably produce valid JSON.
    * ``"incremental"`` — multi-pass authoring: outline → CLP → per-step
      expansion → reports → validate-and-repair loop. Each LLM call has a
      small focused context, so even a 4–9B local model has a reasonable
      shot at producing a valid manifest. ~5–8× more LLM calls than oneshot.
    * ``"swarm"`` — runs ``incremental`` across multiple models concurrently
      (or sequentially if no event loop), then a Judge model synthesizes
      the strongest single manifest from the drafts. Highest quality at
      the cost of N× the token spend.
    * ``"auto"`` (default) — picks ``incremental`` when the resolved model
      is local or thinking-mode, else ``oneshot``.

    Parameters
    ----------
    requirement
        The free-text spec to turn into a manifest.
    workspace
        Workspace name to bake into the manifest.
    model
        Specific model id. Falls back to ``$BENNY_DEFAULT_MODEL`` then a
        live probe of Lemonade/Ollama.
    strategy
        ``"auto" | "oneshot" | "incremental" | "swarm"``.
    swarm_models
        Explicit list of model ids for the swarm. Defaults to ``[primary]``
        plus up to 2 sibling models from the same provider.
    judge_model
        Model id for the swarm Judge. Defaults to the primary model.
    manifest_id
        Force a specific manifest id (defaults to ``pypes-<12hex>``).
    extra_notes
        Free-text steering appended to the user prompt.

    Returns
    -------
    (manifest, meta)
        Validated ``PypesManifest`` and a metadata dict including
        ``strategy``, ``model``, ``manifest_id``, and per-strategy details.

    Raises
    ------
    RuntimeError
        On any LLM or validation failure that survives all retry layers.
    """
    if strategy not in _VALID_STRATEGIES:
        raise ValueError(
            f"plan_pypes_manifest: unknown strategy {strategy!r}; "
            f"expected one of {_VALID_STRATEGIES}"
        )

    manifest_id = manifest_id or f"pypes-{uuid.uuid4().hex[:12]}"
    resolved_model = _resolve_model(model, workspace)

    if strategy == "auto":
        strategy = "incremental" if _prefer_incremental(resolved_model) else "oneshot"
        log.info("planner: auto-selected strategy=%s for model=%s", strategy, resolved_model)

    if strategy == "oneshot":
        return _plan_oneshot(
            requirement=requirement, workspace=workspace, model=resolved_model,
            manifest_id=manifest_id, extra_notes=extra_notes,
            temperature=temperature, max_tokens=max_tokens,
        )
    if strategy == "incremental":
        return _plan_incremental(
            requirement=requirement, workspace=workspace, model=resolved_model,
            manifest_id=manifest_id, extra_notes=extra_notes,
            temperature=temperature, max_tokens=max_tokens,
        )
    # strategy == "swarm"
    return _plan_swarm(
        requirement=requirement, workspace=workspace, primary_model=resolved_model,
        swarm_models=swarm_models, judge_model=judge_model,
        manifest_id=manifest_id, extra_notes=extra_notes,
        temperature=temperature, max_tokens=max_tokens,
    )


def _resolve_model(model: Optional[str], workspace: str) -> str:
    """Resolve a concrete model id from explicit arg, env var, or live probe."""
    resolved_model = model or os.environ.get("BENNY_DEFAULT_MODEL")
    if not resolved_model:
        try:
            from ..core.models import get_active_model

            resolved_model = asyncio.run(get_active_model(workspace_id=workspace, role="chat"))
        except Exception as exc:
            log.debug("planner: get_active_model failed (%s)", exc)
    # ``get_active_model`` falls back to ``lemonade/default`` (a non-existent
    # model id) when its heartbeat URL math fails on ``/api/v1`` bases. Probe
    # Lemonade directly and pick a real chat-capable model id instead.
    if not resolved_model or (isinstance(resolved_model, str) and resolved_model.endswith("/default")):
        from .agent_chat import _first_chat_capable_lemonade_model, _first_ollama_model

        real = _first_chat_capable_lemonade_model()
        if real:
            resolved_model = f"lemonade/{real}"
        elif _first_ollama_model():
            resolved_model = f"ollama/{_first_ollama_model()}"
    if not resolved_model:
        # Conservative final default — local-first per Benny's portability guarantee.
        resolved_model = "ollama/llama3.1"
    return resolved_model


def _prefer_incremental(resolved_model: str) -> bool:
    """Auto-select incremental for local or thinking-mode models.

    Cloud / large models (anthropic, openai, gemini, etc.) handle one-shot
    JSON generation reliably and don't need the multi-pass overhead.
    """
    if not resolved_model:
        return False
    lm = resolved_model.lower()
    if lm.startswith(("lemonade/", "ollama/", "litert/", "local/")):
        return True
    if _is_thinking_model(resolved_model):
        return True
    return False


def _plan_oneshot(
    *,
    requirement: str,
    workspace: str,
    model: str,
    manifest_id: str,
    extra_notes: Optional[str],
    temperature: float,
    max_tokens: int,
) -> Tuple[PypesManifest, Dict[str, Any]]:
    """Single-call planner — works on cloud-class models. Falls back through
    /no_think + retry + JSON repair, but ultimately bets the whole manifest
    on a single model turn.
    """
    resolved_model = model

    # ``str.format`` treats every `{...}` as a placeholder. The embedded JSON
    # example contains literal tokens like ``${data_dir}`` whose `{...}` would
    # explode the formatter. Render placeholders manually instead.
    system_content = (
        _SYSTEM_PROMPT
        .replace("{operations}", "\n".join(f"- {n}" for n in default_registry.names()))
        .replace("{example}", json.dumps(_MINIMAL_EXAMPLE, indent=2))
    )
    system_msg = {"role": "system", "content": system_content}
    user_msg = {
        "role": "user",
        "content": _USER_PROMPT.format(
            requirement=requirement.strip(),
            workspace=workspace,
            manifest_id=manifest_id,
            notes=(extra_notes or "(none)").strip(),
        ),
    }

    # Thinking-mode models (Qwen3, QwQ, DeepSeek-R1) default to chain-of-thought
    # that consumes the entire token budget before any JSON is emitted. We
    # mitigate in three layers:
    #   (a) /no_think directive (honored by stock Qwen3 chat templates)
    #   (b) much larger token budget (some finetunes ignore /no_think)
    #   (c) assistant prefill — start the assistant turn with `{` so the
    #       model is forced to continue inside a JSON object instead of
    #       opening with an English preamble.
    is_thinking = _is_thinking_model(resolved_model)
    if is_thinking:
        user_msg = {
            "role": "user",
            "content": "/no_think\n" + user_msg["content"],
        }
        # Quadruple the budget — small finetunes that ignore /no_think still
        # need ~8–12k tokens of slack to ramble *and* then emit the manifest.
        max_tokens = max(max_tokens, 16384)

    raw = _call_llm(
        resolved_model,
        _with_prefill([system_msg, user_msg], is_thinking),
        temperature,
        max_tokens,
    )
    if is_thinking:
        # Re-attach the prefill so `_extract_json` sees a complete `{...}`.
        raw = "{" + raw if not raw.lstrip().startswith("{") else raw
    payload = _extract_json(raw)

    if payload is None:
        # Retry once with a brutally terse prompt that doesn't give the
        # model any room to philosophize. Drop the long schema spec — the
        # first attempt's reasoning burned through it without producing JSON
        # anyway, so a second pass with the same prompt would just repeat.
        retry_user = {
            "role": "user",
            "content": (
                "/no_think\n"
                "Output ONLY a single valid JSON object for a PypesManifest "
                f"with id={manifest_id!r} and workspace={workspace!r}. "
                "No prose, no markdown, no <think> tags, no explanation. "
                "Start your response with `{` and end with `}`. "
                "Required fields: schema_version, kind, id, name, workspace, "
                "governance, clp, steps. The first step must be stage=bronze "
                "with inputs=[] and a source.{uri,format}. "
                "Original requirement: " + requirement.strip()
            ),
        }
        raw = _call_llm(
            resolved_model,
            _with_prefill([system_msg, retry_user], True),
            temperature,
            max_tokens,
        )
        raw = "{" + raw if not raw.lstrip().startswith("{") else raw
        payload = _extract_json(raw)

    if payload is None:
        hint = ""
        if is_thinking:
            hint = (
                "\n\nHint: this model appears to ignore the JSON-only "
                "instruction and emit chain-of-thought instead. Try a "
                "stronger / non-thinking model (e.g. an Ollama llama3.1 "
                "variant or a cloud model) for the planner."
            )
        raise RuntimeError(
            f"Planner: LLM did not return valid JSON.{hint}\n"
            f"--- raw response (showing 4000 of {len(raw)} chars) ---\n"
            f"{raw[:4000]}"
        )

    # Force the manifest_id and workspace the caller asked for so the user can
    # safely diff between successive plan attempts. ``workspace`` is also
    # authoritative (the CLI flag wins over whatever the model invented).
    payload.setdefault("schema_version", "1.0")
    payload.setdefault("kind", "pypes_pipeline")
    payload["id"] = manifest_id
    payload["workspace"] = workspace

    try:
        manifest = PypesManifest.model_validate(payload)
    except ValidationError as exc:
        raise RuntimeError(
            "Planner: model output failed PypesManifest validation:\n"
            f"{exc}\n--- payload ---\n{json.dumps(payload, indent=2)[:4000]}"
        ) from exc

    meta = {
        "model": resolved_model,
        "manifest_id": manifest_id,
        "workspace": workspace,
        "strategy": "oneshot",
        "raw_response_chars": len(raw),
    }
    return manifest, meta


# ---------------------------------------------------------------------------
# INCREMENTAL STRATEGY — multi-pass authoring for small/local models.
# ---------------------------------------------------------------------------

_OUTLINE_SYSTEM = """You produce JSON outlines of data pipelines. Output ONE JSON object only — no prose, no markdown, no <think> tags.

Schema you must produce:
{
  "name": "<3-10 word pipeline name>",
  "description": "<one sentence>",
  "conceptual": [
    {"name": "EntityName", "description": "<short>"}
  ],
  "step_skeleton": [
    {"id": "bronze_<noun>", "stage": "bronze", "summary": "<<=20 words>"},
    {"id": "silver_<noun>", "stage": "silver", "summary": "..."},
    {"id": "gold_<noun>",   "stage": "gold",   "summary": "..."}
  ]
}

Example:
{
  "name": "Trade Exposure Pipeline",
  "description": "Loads raw trade data and computes counterparty exposure.",
  "conceptual": [
    {"name": "Trade", "description": "Individual financial transaction"},
    {"name": "Exposure", "description": "Aggregated risk per counterparty"}
  ],
  "step_skeleton": [
    {"id": "bronze_trades", "stage": "bronze", "summary": "Load raw CSV from staging"},
    {"id": "silver_clean", "stage": "silver", "summary": "Filter and deduplicate trades"},
    {"id": "gold_risk", "stage": "gold", "summary": "Aggregate notional by counterparty"}
  ]
}

Rules:
- At least one bronze (load), one silver (transform/clean), one gold (aggregate/output) step.
- Step ids: lowercase, prefixed by stage, snake_case.
- 3-7 total steps. Conceptual entities are capitalised business nouns.
- Output JSON only. Begin with `{` and end with `}`.
"""

_CLP_SYSTEM = """You expand business entities into typed logical fields. Output ONE JSON object only.

Schema:
{
  "logical": [
    {
      "entity": "EntityName",
      "fields": [
        {"name": "field_name", "type": "string"|"int"|"float"|"bool"|"datetime", "required": true}
      ]
    }
  ]
}

Example (ALWAYS use double quotes for types):
{
  "logical": [
    {
      "entity": "Trade",
      "fields": [
        {"name": "trade_id", "type": "string", "required": true},
        {"name": "amount", "type": "float", "required": true},
        {"name": "is_active", "type": "bool", "required": true}
      ]
    }
  ]
}

Rules:
- 3-8 fields per entity. Use snake_case names.
- Match entity names exactly to the conceptual list provided.
- EVERY value must be a double-quoted string (except booleans like true/false for the 'required' field).
- Output JSON only.
"""

_STEP_SYSTEM = """You expand a single pipeline step into a complete PipelineStep JSON. Output ONE JSON object only.

Schema for one step:
{
  "id": "<snake_case>",
  "stage": "bronze"|"silver"|"gold",
  "engine": "pandas",
  "inputs": [string],
  "outputs": [string],
  "operations": [{"operation": "<from registered list>", "params": {...}}],
  "source": {"uri": "${data_dir}/<file>", "format": "csv|parquet|json"},
  "post_validations": {"completeness": [...], "uniqueness": [...]}
}

Example (Bronze):
{
  "id": "bronze_load",
  "stage": "bronze",
  "engine": "pandas",
  "inputs": [],
  "outputs": ["raw_data"],
  "source": {"uri": "${data_dir}/input.csv", "format": "csv"},
  "operations": [{"operation": "load", "params": {"source_id": "STAGING"}}]
}

Example (Silver):
{
  "id": "silver_clean",
  "stage": "silver",
  "engine": "pandas",
  "inputs": ["raw_data"],
  "outputs": ["clean_data"],
  "operations": [
    {"operation": "filter", "params": {"column": "status", "op": "==", "value": "A"}}
  ]
}

Rules:
- Bronze step MUST have `inputs: []` and a `source.{uri,format}`.
- Silver/gold steps MUST cite at least one upstream output in `inputs`, and MUST omit `source`.
- Use ONLY operations from the registered list provided.
- Output names are unique across the whole pipeline.
- Use ${data_dir} (not absolute paths). Output JSON only.
"""

_REPORTS_SYSTEM = """You produce reports + governance for a pipeline. Output ONE JSON object only.

Schema:
{
  "governance": {
    "compliance_tags": [string],
    "owner": "<team name>",
    "criticality": "low"|"medium"|"high"|"critical",
    "pii_policy": "block"|"mask"|"allow"
  },
  "reports": [
    {
      "id": "<snake_case>",
      "title": "<human title>",
      "kind": "financial_risk"|"threshold_breaches"|"move_analysis"|"generic_summary",
      "source_step": "<gold step id>",
      "drill_down_by": [string],
      "metrics": {"metric_name": "sum(col)|count(col)|avg(col)"},
      "format": "markdown"
    }
  ]
}

Rules:
- pii_policy MUST be one of "block","mask","allow" (NOT null).
- Each report's source_step MUST match an existing gold step id.
- Output JSON only.
"""

_REPAIR_SYSTEM = """You produce focused JSON patches to fix Pydantic validation errors in a manifest draft.

Output ONE JSON object containing ONLY the top-level keys that need to be replaced
(e.g. {"governance": {...}} or {"steps": [...]}). Do NOT return the full manifest.
Do NOT include keys that are already valid. Output JSON only — no prose.
"""

_JUDGE_SYSTEM = """You synthesize the strongest single PypesManifest from N drafts produced by different models.

Output ONE complete PypesManifest JSON. No commentary, no markdown.

Synthesis rules:
- Pick the most internally-consistent draft as the base.
- Merge in fields from other drafts where they add real value (more validations, better field names, missing reports).
- Resolve conflicts in favor of schema correctness over creativity.
- Preserve manifest_id and workspace exactly as instructed.
- Output JSON only — start with `{` and end with `}`.
"""


def _plan_incremental(
    *,
    requirement: str,
    workspace: str,
    model: str,
    manifest_id: str,
    extra_notes: Optional[str],
    temperature: float,
    max_tokens: int,
) -> Tuple[PypesManifest, Dict[str, Any]]:
    """Multi-pass planner — outline → CLP → per-step → reports → validate+repair.

    Each LLM call has a small focused context, which is the difference between
    "model can hold the whole schema in mind" and "model produces 80% reasoning
    text and never reaches the JSON". Useful for 4–9B local models.
    """
    log.info("planner.incremental: starting model=%s", model)
    notes_suffix = f"\n\nExtra steering notes:\n{extra_notes}" if extra_notes else ""

    # ─── Stage 1: outline ───────────────────────────────────────────────────
    outline = _stage_call(
        system=_OUTLINE_SYSTEM,
        user=f"Requirement:\n{requirement}{notes_suffix}\n\nProduce the outline JSON now.",
        model=model, temperature=temperature, max_tokens=min(max_tokens, 4096),
        stage_name="outline",
    )
    skeleton = outline.get("step_skeleton") or outline.get("steps") or []
    if not skeleton:
        raise RuntimeError(
            "Planner.incremental[outline]: model produced no step skeleton. "
            f"Raw outline: {json.dumps(outline)[:500]}"
        )
    conceptual = outline.get("conceptual", [])

    # ─── Stage 2: CLP logical ───────────────────────────────────────────────
    clp_payload = _stage_call(
        system=_CLP_SYSTEM,
        user=(
            f"Conceptual entities:\n{json.dumps(conceptual, indent=2)}\n\n"
            f"Original requirement:\n{requirement}\n\n"
            "Produce the logical model JSON now."
        ),
        model=model, temperature=temperature, max_tokens=min(max_tokens, 4096),
        stage_name="clp_logical",
    )
    logical = clp_payload.get("logical", [])

    # ─── Stage 3: per-step expansion ────────────────────────────────────────
    ops_list = "\n".join(f"- {n}" for n in default_registry.names())
    steps: List[Dict[str, Any]] = []
    for skel in skeleton:
        upstream_outputs: List[str] = []
        for s in steps:
            upstream_outputs.extend(s.get("outputs", []))
        step_payload = _stage_call(
            system=_STEP_SYSTEM,
            user=(
                f"Step skeleton to expand:\n{json.dumps(skel, indent=2)}\n\n"
                f"Available upstream outputs (from prior steps): {json.dumps(upstream_outputs)}\n\n"
                f"Registered operations (use ONLY these names):\n{ops_list}\n\n"
                f"Original requirement:\n{requirement}\n\n"
                "Produce the single PipelineStep JSON now."
            ),
            model=model, temperature=temperature, max_tokens=min(max_tokens, 4096),
            stage_name=f"step:{skel.get('id', '?')}",
        )
        # Force the step id to match the skeleton — small models tend to
        # rename them, breaking the inputs/outputs DAG references.
        step_payload["id"] = skel.get("id", step_payload.get("id"))
        step_payload.setdefault("stage", skel.get("stage", "silver"))
        step_payload.setdefault("engine", "pandas")
        steps.append(step_payload)

    # ─── Stage 4: reports + governance ──────────────────────────────────────
    gold_summaries = [
        {"id": s.get("id"), "outputs": s.get("outputs", [])}
        for s in steps if s.get("stage") == "gold"
    ]
    reports_payload = _stage_call(
        system=_REPORTS_SYSTEM,
        user=(
            f"Gold steps:\n{json.dumps(gold_summaries, indent=2)}\n\n"
            f"Original requirement:\n{requirement}\n\n"
            "Produce the governance + reports JSON now."
        ),
        model=model, temperature=temperature, max_tokens=min(max_tokens, 4096),
        stage_name="reports",
    )

    # ─── Assembly ───────────────────────────────────────────────────────────
    payload: Dict[str, Any] = {
        "schema_version": "1.0",
        "kind": "pypes_pipeline",
        "id": manifest_id,
        "name": outline.get("name", "Untitled Pipeline"),
        "description": outline.get("description", ""),
        "workspace": workspace,
        "governance": reports_payload.get("governance") or {},
        "clp": {"conceptual": conceptual, "logical": logical},
        "variables": {"data_dir": "${benny_home}/data_in"},
        "steps": steps,
        "reports": reports_payload.get("reports") or [],
    }

    # ─── Stage 5: validate + repair loop ────────────────────────────────────
    manifest, repair_iters = _validate_and_repair(
        payload, requirement=requirement, model=model,
        temperature=temperature, max_tokens=max_tokens,
    )

    meta = {
        "model": model,
        "manifest_id": manifest_id,
        "workspace": workspace,
        "strategy": "incremental",
        "stages": {
            "outline_steps": len(skeleton),
            "clp_entities": len(logical),
            "steps_expanded": len(steps),
            "reports": len(payload["reports"]),
            "repair_iterations": repair_iters,
        },
    }
    return manifest, meta


def _stage_call(
    *,
    system: str,
    user: str,
    model: str,
    temperature: float,
    max_tokens: int,
    stage_name: str,
) -> Dict[str, Any]:
    """Run one focused stage of the incremental planner — small prompt,
    /no_think + assistant-prefill, parse JSON, retry once on failure.
    """
    is_thinking = _is_thinking_model(model)
    user_content = ("/no_think\n" + user) if is_thinking else user
    messages = [
        {"role": "system", "content": system},
        {"role": "user", "content": user_content},
    ]

    raw = _call_llm(model, _with_prefill(messages, is_thinking), temperature, max_tokens)
    if is_thinking and not raw.lstrip().startswith("{"):
        raw = "{" + raw
    payload = _extract_json(raw)
    if payload is not None:
        log.debug("planner.incremental[%s]: parsed on first attempt (%d chars)", stage_name, len(raw))
        return payload

    # Second attempt — terser prompt, force thinking-style suppression.
    terse_user = (
        "/no_think\n"
        "Output ONE valid JSON object exactly matching the schema in the system "
        "prompt. No prose, no markdown, no <think> tags. Begin with `{` and end "
        f"with `}}`.\n\n{user}"
    )
    messages = [
        {"role": "system", "content": system},
        {"role": "user", "content": terse_user},
    ]
    raw = _call_llm(model, _with_prefill(messages, True), temperature, max_tokens)
    if not raw.lstrip().startswith("{"):
        raw = "{" + raw
    payload = _extract_json(raw)
    if payload is not None:
        log.debug("planner.incremental[%s]: parsed on retry (%d chars)", stage_name, len(raw))
        return payload

    raise RuntimeError(
        f"Planner.incremental[{stage_name}]: model {model!r} produced unparseable "
        f"output after retry.\n--- raw (showing 2000 of {len(raw)}) ---\n{raw[:2000]}"
    )


def _validate_and_repair(
    payload: Dict[str, Any],
    *,
    requirement: str,
    model: str,
    temperature: float,
    max_tokens: int,
    max_iters: int = 3,
) -> Tuple[PypesManifest, int]:
    """Try Pydantic validation; on failure, ask the model for a focused patch
    and re-merge. Returns (manifest, iterations_used).
    """
    last_err: Optional[ValidationError] = None
    for attempt in range(max_iters + 1):
        try:
            return PypesManifest.model_validate(payload), attempt
        except ValidationError as exc:
            last_err = exc
            log.info(
                "planner.repair[%d/%d]: %d validation error(s)",
                attempt, max_iters, len(exc.errors()),
            )
            if attempt >= max_iters:
                break
            try:
                patch = _stage_call(
                    system=_REPAIR_SYSTEM,
                    user=(
                        f"Validation errors:\n{str(exc)[:1500]}\n\n"
                        f"Current manifest payload (truncated):\n"
                        f"{json.dumps(payload, indent=2)[:3000]}\n\n"
                        f"Original requirement:\n{requirement}\n\n"
                        "Produce a JSON patch object containing ONLY the top-level "
                        "keys to replace. Do NOT return the full manifest."
                    ),
                    model=model, temperature=temperature,
                    max_tokens=min(max_tokens, 4096),
                    stage_name=f"repair#{attempt}",
                )
            except RuntimeError as repair_exc:
                log.warning("planner.repair[%d]: patch call failed: %s", attempt, repair_exc)
                break
            if not patch:
                break
            # Shallow merge — patch keys overwrite payload keys wholesale.
            for k, v in patch.items():
                payload[k] = v

    raise RuntimeError(
        "Planner.incremental: validation failed after repair loop.\n"
        f"Last error:\n{last_err}\n--- payload (truncated) ---\n"
        f"{json.dumps(payload, indent=2)[:4000]}"
    )


# ---------------------------------------------------------------------------
# SWARM STRATEGY — multiple models draft concurrently, Judge synthesizes.
# ---------------------------------------------------------------------------


def _plan_swarm(
    *,
    requirement: str,
    workspace: str,
    primary_model: str,
    swarm_models: Optional[List[str]],
    judge_model: Optional[str],
    manifest_id: str,
    extra_notes: Optional[str],
    temperature: float,
    max_tokens: int,
) -> Tuple[PypesManifest, Dict[str, Any]]:
    """Run incremental on N models, then synthesize the winning manifest.

    Members run sequentially (each is itself a multi-call sequence; running
    them in parallel would multiply local GPU contention without much wall-
    clock win for a single-GPU host). The Judge call sees all surviving
    drafts and emits one synthesized manifest.
    """
    members = swarm_models or _default_swarm_members(primary_model)
    log.info("planner.swarm: members=%s", members)

    drafts: List[Tuple[str, PypesManifest]] = []
    failures: List[Dict[str, str]] = []
    for m in members:
        try:
            mf, _ = _plan_incremental(
                requirement=requirement, workspace=workspace, model=m,
                manifest_id=manifest_id, extra_notes=extra_notes,
                temperature=temperature, max_tokens=max_tokens,
            )
            drafts.append((m, mf))
            log.info("planner.swarm: member %s produced a valid draft", m)
        except Exception as exc:
            failures.append({"model": m, "error": str(exc)[:300]})
            log.warning("planner.swarm: member %s failed: %s", m, exc)

    if not drafts:
        raise RuntimeError(
            "Planner.swarm: no swarm members produced a valid draft.\n"
            f"Failures: {json.dumps(failures, indent=2)[:2000]}"
        )

    if len(drafts) == 1:
        only_model, only_mf = drafts[0]
        return only_mf, {
            "model": only_model, "manifest_id": manifest_id,
            "workspace": workspace, "strategy": "swarm",
            "swarm_members": [only_model], "swarm_drafts": 1,
            "swarm_failures": failures, "judge": None,
        }

    judge = judge_model or primary_model
    final = _stage_judge(
        drafts=drafts, requirement=requirement, manifest_id=manifest_id,
        workspace=workspace, judge=judge,
        temperature=temperature, max_tokens=max_tokens,
    )
    return final, {
        "model": judge, "manifest_id": manifest_id, "workspace": workspace,
        "strategy": "swarm",
        "swarm_members": [m for m, _ in drafts],
        "swarm_drafts": len(drafts),
        "swarm_failures": failures,
        "judge": judge,
    }


def _default_swarm_members(primary: str) -> List[str]:
    """Pick the primary plus up to 2 sibling models from the same provider."""
    members = [primary]
    if "/" not in primary:
        return members
    provider, _, _ = primary.partition("/")
    try:
        from .agent_chat import _list_lemonade_models, _list_ollama_models

        candidates: List[str] = []
        if provider == "lemonade":
            for mid, _labels, _size in _list_lemonade_models():
                if any(skip in mid.lower() for skip in ("embed", "whisper", "kokoro", "nomic")):
                    continue
                full = f"lemonade/{mid}"
                if full != primary:
                    candidates.append(full)
        elif provider == "ollama":
            for mid, _labels, _size in _list_ollama_models():
                full = f"ollama/{mid}"
                if full != primary:
                    candidates.append(full)
        for c in candidates[:2]:
            members.append(c)
    except Exception as exc:
        log.debug("planner.swarm: member enumeration failed: %s", exc)
    return members


def _stage_judge(
    *,
    drafts: List[Tuple[str, PypesManifest]],
    requirement: str,
    manifest_id: str,
    workspace: str,
    judge: str,
    temperature: float,
    max_tokens: int,
) -> PypesManifest:
    """Synthesize one PypesManifest from N drafts via the Judge model."""
    drafts_payload = [
        {"model": m, "manifest": mf.model_dump(mode="json")}
        for m, mf in drafts
    ]
    user = (
        f"Original requirement:\n{requirement}\n\n"
        f"Drafts from {len(drafts)} models (truncated to fit):\n"
        f"{json.dumps(drafts_payload, indent=2)[:8000]}\n\n"
        f"Synthesize the strongest single PypesManifest. "
        f"Use id={manifest_id!r} and workspace={workspace!r} exactly. "
        "Output ONE complete manifest JSON."
    )
    try:
        payload = _stage_call(
            system=_JUDGE_SYSTEM, user=user, model=judge,
            temperature=temperature, max_tokens=max(max_tokens, 16384),
            stage_name="judge",
        )
    except RuntimeError as exc:
        log.warning("planner.swarm.judge: synthesis call failed (%s); falling back to first draft", exc)
        return drafts[0][1]

    payload["id"] = manifest_id
    payload["workspace"] = workspace
    payload.setdefault("schema_version", "1.0")
    payload.setdefault("kind", "pypes_pipeline")
    try:
        return PypesManifest.model_validate(payload)
    except ValidationError as exc:
        log.warning(
            "planner.swarm.judge: synthesis output failed validation (%s); "
            "falling back to first valid draft", exc,
        )
        return drafts[0][1]


# ---------------------------------------------------------------------------
# INTERNALS
# ---------------------------------------------------------------------------


def _call_llm(
    model: str,
    messages: List[Dict[str, str]],
    temperature: float,
    max_tokens: int,
) -> str:
    """Run ``call_model()`` synchronously, regardless of caller event loop."""
    from ..core.models import call_model

    coro = call_model(
        model=model,
        messages=messages,
        temperature=temperature,
        max_tokens=max_tokens,
    )
    try:
        return asyncio.run(coro)
    except RuntimeError as exc:
        # Fallback path when an outer loop is already running (rare from CLI).
        if "asyncio.run() cannot be called" in str(exc):
            loop = asyncio.new_event_loop()
            try:
                return loop.run_until_complete(coro)
            finally:
                loop.close()
        raise


_FENCE_RE = re.compile(r"```(?:json)?\s*(\{.*?\})\s*```", re.DOTALL | re.IGNORECASE)
_THINK_RE = re.compile(r"<think>.*?</think>", re.DOTALL | re.IGNORECASE)

# Trailing comma before `}` or `]` — invalid in standard JSON, common in
# LLM output. Captures the closing bracket so the substitution preserves it.
_TRAILING_COMMA_RE = re.compile(r",(\s*[}\]])")

# Fake "comment" keys some finetunes (notably Qwen3.5-FLM) invent because
# JSON has no native comments. Pattern: ``"_commented_out_<anything>": <value>``
# followed by an optional comma. We strip these key/value pairs entirely.
_COMMENT_KEY_RE = re.compile(
    r'"_commented_out_[^"]*"\s*:\s*'
    r'(?:"[^"]*"|true|false|null|-?\d+(?:\.\d+)?)'
    r'\s*,?',
    re.IGNORECASE,
)

# `// line comment` and `/* block */` — also occasionally hallucinated.
_LINE_COMMENT_RE = re.compile(r"//[^\n]*")
_BLOCK_COMMENT_RE = re.compile(r"/\*.*?\*/", re.DOTALL)

# Models that need /no_think to suppress chain-of-thought preamble.
_THINKING_MODEL_PATTERNS = ("qwen3", "qwq", "deepseek-r1", "deepseek-r2")


def _is_thinking_model(model: str) -> bool:
    lm = model.lower()
    return any(p in lm for p in _THINKING_MODEL_PATTERNS)


def _with_prefill(messages: List[Dict[str, str]], enabled: bool) -> List[Dict[str, str]]:
    """Append an assistant prefill of ``{`` so the model continues inside a
    JSON object instead of opening with English prose.

    OpenAI-compatible servers (Lemonade, Ollama, vLLM) treat a trailing
    assistant message as a partial completion to continue from. The leading
    ``{`` becomes the first token the model sees on its turn — strongly
    biasing it toward completing the JSON literal rather than starting a
    sentence with "Okay, let's tackle...".
    """
    if not enabled:
        return messages
    return list(messages) + [{"role": "assistant", "content": "{"}]


def _repair_json(text: str) -> str:
    """Best-effort cleanup of LLM-emitted JSON quirks before strict parsing.

    Handles three patterns we've observed in the wild from local models:

    1. Trailing commas before ``}`` or ``]`` (some chat templates strip the
       final field-separator handling and the model leaves a stray comma).
    2. ``"_commented_out_..."`` keys — qwen3.5-FLM tries to "comment out"
       fields by inventing fake keys with ``true`` values.
    3. ``//`` and ``/* ... */`` comments — JSON5-style hallucinations.
    """
    text = _BLOCK_COMMENT_RE.sub("", text)
    text = _LINE_COMMENT_RE.sub("", text)
    text = _COMMENT_KEY_RE.sub("", text)
    # Run trailing-comma cleanup *after* comment removal so a deleted
    # `_commented_out_*` pair that left a dangling comma is still cleaned.
    text = _TRAILING_COMMA_RE.sub(r"\1", text)
    return text


def _try_parse(text: str) -> Optional[Dict[str, Any]]:
    """Try strict parse, fall back to robust parse_json_safe."""
    try:
        # Standard fast path
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    
    try:
        # Robust fallback path
        payload, _ = parse_json_safe(text)
        return payload
    except Exception:
        return None


def _extract_json(text: str) -> Optional[Dict[str, Any]]:
    """Be forgiving: strip optional ```json fences, find the outermost JSON object.
    Uses the robust parse_json_safe utility from swarm logic.
    """
    if not text:
        return None

    # 1. Direct parse (with repair fallback).
    payload = _try_parse(text)
    if payload is not None:
        return payload

    # 2. Triple-backtick fenced block.
    m = _FENCE_RE.search(text)
    if m:
        payload = _try_parse(m.group(1))
        if payload is not None:
            return payload

    # 3. Outermost { ... } slice — last resort for chatty models.
    #    Use the *last* closing brace so reasoning text before the JSON doesn't
    #    get included in the slice, and partial-truncated trailing prose is
    #    cut at the final complete brace.
    start = text.find("{")
    end = text.rfind("}")
    if start != -1 and end > start:
        return _try_parse(text[start : end + 1])
    return None
