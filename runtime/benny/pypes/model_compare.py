"""Cross-model performance + quality comparison for pypes sandbox tasks.

Runs the **same task** (planner / agent-report / chat-qa) through N
different LLMs and produces a side-by-side scorecard covering:

* **Wall time**            (seconds per call)
* **Tokens in / out**       (counted via tiktoken — provider-independent)
* **Content size**          (response chars + parsed-JSON byte size)
* **Cost (USD)**            (token-based when ``cost_per_1k_*`` set,
                             compute-based otherwise via ``$BENNY_COMPUTE_COST_USD_PER_HOUR``)
* **Process CPU + RSS**     (psutil, same sampler as ``bench.py``)
* **Accuracy** (auto)       (task-specific rubric — schema validity,
                             required ops present, step count, etc.)
* **Quality** (LLM judge)   (optional second-model scoring 0-10 with rationale)

The comparison is configured by a JSON spec (``ModelCompareSpec`` / see
``manifests/templates/model_comparison_planner.json``). Spec is portable
under ``${benny_home}`` per the SR-1 gate. Every trial writes its raw
LLM output to disk so the user can diff manifests / narratives manually.

This module sits in the **sandbox layer**: it never touches deterministic
run audit data, never mutates ``$BENNY_HOME/runs/``, and writes only to
``${benny_home}/runs/model-compare/<comparison_id>/``.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from pydantic import BaseModel, Field, ValidationError

from .bench import _ResourceSampler  # reuse psutil sampler
from .models import PypesManifest

log = logging.getLogger(__name__)


# =============================================================================
# SPEC SCHEMA
# =============================================================================


class JudgeConfig(BaseModel):
    enabled: bool = False
    model: Optional[str] = None
    """Second-pass LLM that scores each trial's output 0-10 with rationale."""
    rubric: str = (
        "Score the output on three axes (each 0-10):\n"
        "  - completeness: covers all the points the requirement asks for\n"
        "  - faithfulness: stays grounded in the requirement / facts; no hallucination\n"
        "  - usability:    a domain expert could act on the output without rework\n"
        "Return JSON: {\"completeness\": int, \"faithfulness\": int, \"usability\": int, "
        "\"rationale\": \"<2 sentences>\"}"
    )
    max_tokens: int = 400


class ModelEntry(BaseModel):
    label: str
    """Short display id used in tables (e.g. ``qwen3-tk-4b``)."""
    id: str
    """Routable model id (e.g. ``lemonade/qwen3-tk-4b-FLM`` or ``openai/gpt-4o``)."""
    cost_per_1k_in: Optional[float] = None
    """USD per 1k prompt tokens. If null, compute-time cost is used instead."""
    cost_per_1k_out: Optional[float] = None
    """USD per 1k completion tokens. If null, compute-time cost is used instead."""
    max_tokens: int = 4096
    temperature: float = 0.2


class ModelCompareSpec(BaseModel):
    schema_version: str = "1.0"
    kind: str = Field(default="pypes_model_comparison", pattern="^pypes_model_comparison$")
    id: str
    name: str
    task: str = Field(..., pattern="^(plan|agent_report|chat_qa)$")
    """One of:
       * ``plan``         — generate a PypesManifest from ``requirement``
       * ``agent_report`` — write a risk narrative for ``run_id`` (run_id required)
       * ``chat_qa``      — answer ``question`` against ``run_id`` (run_id required)
    """
    workspace: str = "default"
    requirement: Optional[str] = None
    """Required when ``task == 'plan'``."""
    run_id: Optional[str] = None
    """Required when ``task in {'agent_report', 'chat_qa'}``."""
    question: Optional[str] = None
    """Required when ``task == 'chat_qa'``."""
    models: List[ModelEntry]
    repeats: int = 1
    """Run each model N times. Best-of-N (lowest wall time) is reported."""
    judge: JudgeConfig = Field(default_factory=JudgeConfig)
    rubric_required_ops: List[str] = Field(default_factory=list)
    """For ``plan`` task: list of operation names the manifest MUST use to score full points."""
    rubric_min_steps: int = 3
    rubric_min_gold_steps: int = 1
    output_dir: str = "${benny_home}/runs/model-compare"


# =============================================================================
# RESULT CONTAINERS
# =============================================================================


@dataclass
class TrialScores:
    """Auto-rubric scores. Each field is in [0.0, 1.0]."""
    schema_valid: float = 0.0
    has_required_ops: float = 0.0
    step_count_ok: float = 0.0
    has_gold_steps: float = 0.0
    has_validations: float = 0.0
    has_reports: float = 0.0
    nonempty_response: float = 0.0
    detail: Dict[str, Any] = field(default_factory=dict)

    @property
    def total(self) -> float:
        """Mean of the 7 sub-scores, in [0.0, 1.0]."""
        scores = [
            self.schema_valid, self.has_required_ops, self.step_count_ok,
            self.has_gold_steps, self.has_validations, self.has_reports,
            self.nonempty_response,
        ]
        return round(sum(scores) / len(scores), 3)


@dataclass
class JudgeScore:
    completeness: int = 0
    faithfulness: int = 0
    usability: int = 0
    rationale: str = ""

    @property
    def total(self) -> float:
        """Mean of the three axes, in [0.0, 10.0]."""
        return round((self.completeness + self.faithfulness + self.usability) / 3, 2)


@dataclass
class TrialResult:
    label: str
    model_id: str
    repeat_idx: int
    wall_seconds: float
    cpu_seconds: float
    cpu_percent_mean: float
    rss_mb_peak: float
    rss_mb_delta: float
    prompt_tokens: int
    completion_tokens: int
    response_chars: int
    response_path: str
    cost_usd: float
    auto_scores: TrialScores
    judge_score: Optional[JudgeScore] = None
    error: Optional[str] = None

    @property
    def status(self) -> str:
        return "FAILED" if self.error else "OK"

    @property
    def total_tokens(self) -> int:
        return self.prompt_tokens + self.completion_tokens

    @property
    def quality_score(self) -> float:
        """Blended quality in [0.0, 1.0]: 60% auto + 40% judge (when present)."""
        if self.judge_score is None:
            return self.auto_scores.total
        judge_norm = self.judge_score.total / 10.0
        return round(self.auto_scores.total * 0.6 + judge_norm * 0.4, 3)


@dataclass
class ComparisonResult:
    spec_id: str
    spec_name: str
    task: str
    workspace: str
    output_dir: str
    started_at: str
    finished_at: str
    trials: List[TrialResult]
    """One per (model, repeat). Use ``best_per_model()`` for the headline scorecard."""

    def best_per_model(self) -> List[TrialResult]:
        by_label: Dict[str, List[TrialResult]] = {}
        for t in self.trials:
            by_label.setdefault(t.label, []).append(t)
        out: List[TrialResult] = []
        for label, ts in by_label.items():
            ok = [t for t in ts if not t.error]
            if ok:
                out.append(min(ok, key=lambda t: t.wall_seconds))
            else:
                out.append(ts[0])  # surface the failure
        return out

    def to_dict(self) -> Dict[str, Any]:
        return {
            "spec_id": self.spec_id,
            "spec_name": self.spec_name,
            "task": self.task,
            "workspace": self.workspace,
            "output_dir": self.output_dir,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "trials": [_trial_to_dict(t) for t in self.trials],
            "best_per_model": [_trial_to_dict(t) for t in self.best_per_model()],
        }


def _trial_to_dict(t: TrialResult) -> Dict[str, Any]:
    return {
        "label": t.label,
        "model_id": t.model_id,
        "repeat_idx": t.repeat_idx,
        "status": t.status,
        "wall_seconds": t.wall_seconds,
        "cpu_seconds": t.cpu_seconds,
        "cpu_percent_mean": t.cpu_percent_mean,
        "rss_mb_peak": t.rss_mb_peak,
        "rss_mb_delta": t.rss_mb_delta,
        "prompt_tokens": t.prompt_tokens,
        "completion_tokens": t.completion_tokens,
        "total_tokens": t.total_tokens,
        "response_chars": t.response_chars,
        "response_path": t.response_path,
        "cost_usd": t.cost_usd,
        "auto_score_total": t.auto_scores.total,
        "auto_score_detail": {
            "schema_valid": t.auto_scores.schema_valid,
            "has_required_ops": t.auto_scores.has_required_ops,
            "step_count_ok": t.auto_scores.step_count_ok,
            "has_gold_steps": t.auto_scores.has_gold_steps,
            "has_validations": t.auto_scores.has_validations,
            "has_reports": t.auto_scores.has_reports,
            "nonempty_response": t.auto_scores.nonempty_response,
        },
        "judge_score": (
            None if t.judge_score is None
            else {
                "completeness": t.judge_score.completeness,
                "faithfulness": t.judge_score.faithfulness,
                "usability": t.judge_score.usability,
                "rationale": t.judge_score.rationale,
                "total": t.judge_score.total,
            }
        ),
        "quality_score": t.quality_score,
        "error": t.error,
    }


# =============================================================================
# SPEC LOADING
# =============================================================================


def _expand_paths(value: str) -> str:
    """Replace ``${benny_home}`` (and friends) with real paths."""
    home = os.environ.get("BENNY_HOME") or str(Path.home() / ".benny")
    return (
        value
        .replace("${benny_home}", home)
        .replace("${BENNY_HOME}", home)
    )


def load_spec(path: str) -> ModelCompareSpec:
    raw = json.loads(Path(path).read_text(encoding="utf-8"))
    spec = ModelCompareSpec.model_validate(raw)
    if spec.task == "plan" and not spec.requirement:
        raise ValueError("spec.task='plan' requires spec.requirement")
    if spec.task in ("agent_report", "chat_qa") and not spec.run_id:
        raise ValueError(f"spec.task='{spec.task}' requires spec.run_id")
    if spec.task == "chat_qa" and not spec.question:
        raise ValueError("spec.task='chat_qa' requires spec.question")
    if not spec.models:
        raise ValueError("spec.models must list at least one ModelEntry")
    return spec


# =============================================================================
# TOKEN COUNTING (provider-agnostic)
# =============================================================================


_ENCODING = None


def _get_encoding():
    global _ENCODING
    if _ENCODING is None:
        try:
            import tiktoken
            enc = tiktoken.get_encoding("cl100k_base")
            # Stubbed test environments may return None — treat as fallback.
            _ENCODING = enc if enc is not None and hasattr(enc, "encode") else "fallback"
        except Exception:
            _ENCODING = "fallback"
    return _ENCODING


def count_tokens(text: str) -> int:
    """Approximate token count (cl100k_base if tiktoken available; ~4 chars/token else)."""
    if not text:
        return 0
    enc = _get_encoding()
    if enc == "fallback" or not hasattr(enc, "encode"):
        return max(1, len(text) // 4)
    try:
        return len(enc.encode(text))
    except Exception:
        return max(1, len(text) // 4)


# =============================================================================
# COST MODEL
# =============================================================================


def trial_cost(
    *, model: ModelEntry, prompt_tokens: int, completion_tokens: int, wall_seconds: float
) -> float:
    """Token-priced when both ``cost_per_1k_*`` are set; compute-priced otherwise.

    Local models default to compute pricing via
    ``$BENNY_COMPUTE_COST_USD_PER_HOUR`` (defaults to $0.20/hr).
    """
    if model.cost_per_1k_in is not None and model.cost_per_1k_out is not None:
        return round(
            (prompt_tokens / 1000.0) * model.cost_per_1k_in
            + (completion_tokens / 1000.0) * model.cost_per_1k_out,
            6,
        )
    rate = float(os.environ.get("BENNY_COMPUTE_COST_USD_PER_HOUR", "0.20"))
    return round(wall_seconds / 3600.0 * rate, 6)


# =============================================================================
# AUTO-RUBRIC SCORERS
# =============================================================================


_FENCE_RE = re.compile(r"```(?:json)?\s*(\{.*?\})\s*```", re.DOTALL | re.IGNORECASE)


def _extract_json(text: str) -> Optional[Dict[str, Any]]:
    """Mirror of planner._extract_json — be forgiving with chatty models."""
    if not text:
        return None
    text = text.strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    m = _FENCE_RE.search(text)
    if m:
        try:
            return json.loads(m.group(1))
        except json.JSONDecodeError:
            pass
    s, e = text.find("{"), text.rfind("}")
    if s != -1 and e > s:
        try:
            return json.loads(text[s : e + 1])
        except json.JSONDecodeError:
            return None
    return None


def score_plan_output(
    text: str, *, required_ops: List[str], min_steps: int, min_gold_steps: int
) -> TrialScores:
    """Run all auto-rubric checks against an LLM-emitted PypesManifest."""
    scores = TrialScores()
    scores.nonempty_response = 1.0 if text and text.strip() else 0.0

    payload = _extract_json(text)
    scores.detail["json_extracted"] = payload is not None
    if payload is None:
        return scores

    try:
        manifest = PypesManifest.model_validate(payload)
        scores.schema_valid = 1.0
    except ValidationError as exc:
        scores.detail["validation_error"] = str(exc)[:500]
        return scores

    # Step count
    n_steps = len(manifest.steps)
    scores.step_count_ok = 1.0 if n_steps >= min_steps else round(n_steps / max(min_steps, 1), 2)
    scores.detail["step_count"] = n_steps

    # Gold steps
    gold = [s for s in manifest.steps if s.stage.value == "gold"]
    scores.has_gold_steps = (
        1.0 if len(gold) >= min_gold_steps
        else round(len(gold) / max(min_gold_steps, 1), 2)
    )
    scores.detail["gold_steps"] = len(gold)

    # Required ops coverage
    used_ops = set()
    for s in manifest.steps:
        for op in (s.operations or []):
            used_ops.add(op.operation)
    if required_ops:
        hits = sum(1 for op in required_ops if op in used_ops)
        scores.has_required_ops = round(hits / len(required_ops), 2)
        scores.detail["ops_hit"] = hits
        scores.detail["ops_total_required"] = len(required_ops)
    else:
        scores.has_required_ops = 1.0  # nothing to satisfy
    scores.detail["ops_used"] = sorted(used_ops)

    # Validations
    has_val = any(
        getattr(s, "post_validations", None)
        and any(v for v in s.post_validations.model_dump().values() if v)
        for s in manifest.steps
    )
    scores.has_validations = 1.0 if has_val else 0.0

    # Reports
    scores.has_reports = 1.0 if (manifest.reports and len(manifest.reports) > 0) else 0.0
    scores.detail["report_count"] = len(manifest.reports or [])

    return scores


def score_narrative_output(text: str) -> TrialScores:
    """Cheap auto-rubric for ``agent_report`` / ``chat_qa`` — structural checks only."""
    scores = TrialScores()
    if not text or not text.strip():
        return scores
    scores.nonempty_response = 1.0
    # We can't validate a manifest, so reward structural cues a risk-analyst
    # narrative usually has: numbered headings, bullet lists, and quoted USD figures.
    has_md_section = bool(re.search(r"(^|\n)#{1,3}\s+\w", text))
    has_bullets = bool(re.search(r"(^|\n)[-*]\s+\w", text))
    has_usd = bool(re.search(r"\$\s?\d", text)) or bool(re.search(r"\busd\b", text, re.I))
    scores.schema_valid = 1.0  # n/a — structural, not schema
    scores.has_required_ops = 1.0 if has_bullets else 0.0
    scores.step_count_ok = 1.0 if has_md_section else 0.0
    scores.has_gold_steps = 1.0 if has_usd else 0.0
    scores.has_validations = 1.0 if len(text) > 400 else round(len(text) / 400, 2)
    scores.has_reports = 1.0 if has_md_section and has_bullets else 0.0
    scores.detail["chars"] = len(text)
    scores.detail["has_md_section"] = has_md_section
    scores.detail["has_bullets"] = has_bullets
    scores.detail["has_usd"] = has_usd
    return scores


# =============================================================================
# JUDGE
# =============================================================================


def judge_output(
    judge_cfg: JudgeConfig, *, requirement: str, response_text: str
) -> Optional[JudgeScore]:
    """Run the LLM judge against one trial's output. Returns None on any failure."""
    if not judge_cfg.enabled or not judge_cfg.model:
        return None
    try:
        from ..core.models import call_model
    except Exception as exc:
        log.debug("judge: cannot import call_model (%s)", exc)
        return None

    user = (
        f"# Task requirement / question\n{requirement.strip()}\n\n"
        f"# Candidate output\n{response_text[:6000]}\n\n"
        f"# Scoring rubric\n{judge_cfg.rubric}\n"
    )
    msgs = [
        {"role": "system", "content": "You are an impartial senior reviewer scoring an LLM's output."},
        {"role": "user", "content": user},
    ]
    try:
        coro = call_model(
            model=judge_cfg.model, messages=msgs, temperature=0.0,
            max_tokens=judge_cfg.max_tokens,
        )
        try:
            raw = asyncio.run(coro)
        except RuntimeError as exc:
            if "asyncio.run() cannot be called" in str(exc):
                loop = asyncio.new_event_loop()
                try:
                    raw = loop.run_until_complete(coro)
                finally:
                    loop.close()
            else:
                raise
    except Exception as exc:
        log.debug("judge: call failed (%s)", exc)
        return None

    payload = _extract_json(raw or "")
    if not payload:
        return None
    try:
        return JudgeScore(
            completeness=int(payload.get("completeness", 0)),
            faithfulness=int(payload.get("faithfulness", 0)),
            usability=int(payload.get("usability", 0)),
            rationale=str(payload.get("rationale", ""))[:500],
        )
    except (TypeError, ValueError):
        return None


# =============================================================================
# TASK RUNNERS
# =============================================================================


def _call_with_sampler(
    *, model: str, messages: List[Dict[str, str]], temperature: float, max_tokens: int,
    sample_interval: float = 0.05,
) -> Tuple[str, _ResourceSampler, float]:
    """Invoke ``call_model`` synchronously and capture wall + resource samples."""
    from ..core.models import call_model

    coro = call_model(
        model=model, messages=messages,
        temperature=temperature, max_tokens=max_tokens,
    )
    t0 = time.perf_counter()
    with _ResourceSampler(interval_seconds=sample_interval) as sampler:
        try:
            raw = asyncio.run(coro)
        except RuntimeError as exc:
            if "asyncio.run() cannot be called" in str(exc):
                loop = asyncio.new_event_loop()
                try:
                    raw = loop.run_until_complete(coro)
                finally:
                    loop.close()
            else:
                raise
    wall = time.perf_counter() - t0
    return raw, sampler, wall


def _build_plan_messages(spec: ModelCompareSpec) -> Tuple[List[Dict[str, str]], str]:
    """Assemble planner messages — re-uses ``planner._SYSTEM_PROMPT`` shape."""
    from . import planner as _planner
    from .registry import default_registry

    system_content = (
        _planner._SYSTEM_PROMPT
        .replace("{operations}", "\n".join(f"- {n}" for n in default_registry.names()))
        .replace("{example}", json.dumps(_planner._MINIMAL_EXAMPLE, indent=2))
    )
    user_content = _planner._USER_PROMPT.format(
        requirement=(spec.requirement or "").strip(),
        workspace=spec.workspace,
        manifest_id=f"compare-{uuid.uuid4().hex[:8]}",
        notes="(none)",
    )
    return (
        [
            {"role": "system", "content": system_content},
            {"role": "user", "content": user_content},
        ],
        spec.requirement or "",
    )


def _build_agent_report_messages(spec: ModelCompareSpec) -> Tuple[List[Dict[str, str]], str]:
    """Re-use the agent-report system prompt + facts payload."""
    from . import agent_report as _ar

    ws_root = _resolve_workspace_root(spec.workspace)
    run_dir = ws_root / "runs" / f"pypes-{spec.run_id}"
    receipt = _ar.RunReceipt.model_validate_json((run_dir / "receipt.json").read_text(encoding="utf-8"))
    manifest = _ar._load_run_manifest(run_dir)
    if manifest is None:
        raise FileNotFoundError(f"Manifest snapshot missing for run {spec.run_id}")
    facts = _ar._collect_facts(run_dir, manifest, receipt)

    agent = _ar.RiskAnalystAgent()
    skills_block = "\n".join(f"  - {s}" for s in agent.skills)
    facts_json = json.dumps(facts, indent=2, default=str)
    budget = int(os.environ.get("BENNY_PYPES_FACTS_CHAR_BUDGET", "5000"))
    if len(facts_json) > budget:
        facts_json = facts_json[:budget] + f"\n... [truncated to {budget} chars]"

    sys_prompt = (
        f"{agent.persona}\n\nFRAMEWORK CONTEXT:\n{agent.framework_context}\n\n"
        f"AUTHORISED SKILLS:\n{skills_block}\n\nOUTPUT CONTRACT:\n{agent.output_format}"
    )
    user = (
        f"# Run under analysis\n- Manifest: `{manifest.id}` ({manifest.name})\n"
        f"- Workspace: `{manifest.workspace}`\n- Run id: `{spec.run_id}`\n"
        f"- Status: `{receipt.status}`\n\n"
        f"# Gold-layer facts\n```json\n{facts_json}\n```\n\n"
        f"Now write the risk-analyst narrative."
    )
    return (
        [
            {"role": "system", "content": sys_prompt},
            {"role": "user", "content": user},
        ],
        "Write a counterparty-risk narrative for the run above.",
    )


def _build_chat_qa_messages(spec: ModelCompareSpec) -> Tuple[List[Dict[str, str]], str]:
    """Single-turn QA against a finished run, mirroring ``ChatHarness._build_system_prompt``."""
    from . import agent_chat as _ac
    from . import agent_report as _ar

    ws_root = _resolve_workspace_root(spec.workspace)
    harness = _ac.ChatHarness(workspace_root=ws_root, run_id=spec.run_id, model=spec.models[0].id)
    msgs = [
        {"role": "system", "content": harness.system_prompt},
        {"role": "user",   "content": spec.question or ""},
    ]
    return msgs, (spec.question or "")


def _resolve_workspace_root(workspace: str) -> Path:
    home = Path(os.environ.get("BENNY_HOME") or (Path.home() / ".benny"))
    return home / "workspaces" / workspace


# =============================================================================
# MAIN ORCHESTRATOR
# =============================================================================


def run_model_comparison(spec: ModelCompareSpec) -> ComparisonResult:
    """Run every (model x repeat) trial sequentially and write artifacts to disk.

    Trials are sequential — concurrent runs would poison the CPU/RSS sampler.
    """
    started_at = datetime.utcnow().isoformat() + "Z"
    out_root = Path(_expand_paths(spec.output_dir)) / spec.id
    out_root.mkdir(parents=True, exist_ok=True)

    # Build messages once per task. Same prompt, different models — that's the
    # whole point of a fair comparison.
    if spec.task == "plan":
        base_messages, judge_input = _build_plan_messages(spec)
    elif spec.task == "agent_report":
        base_messages, judge_input = _build_agent_report_messages(spec)
    elif spec.task == "chat_qa":
        base_messages, judge_input = _build_chat_qa_messages(spec)
    else:
        raise ValueError(f"unknown task: {spec.task}")

    trials: List[TrialResult] = []
    for model in spec.models:
        for repeat_idx in range(1, spec.repeats + 1):
            log.info("model_compare: %s / %s (repeat %s/%s)",
                     spec.task, model.label, repeat_idx, spec.repeats)
            messages = [dict(m) for m in base_messages]  # shallow copy per-call
            error = None
            raw_text = ""
            wall = 0.0
            sampler = None
            try:
                raw_text, sampler, wall = _call_with_sampler(
                    model=model.id, messages=messages,
                    temperature=model.temperature, max_tokens=model.max_tokens,
                )
            except Exception as exc:
                error = str(exc)[:500]
                log.warning("model_compare: %s failed (%s)", model.label, exc)

            # Persist the raw response for manual diffing.
            ext = "json" if spec.task == "plan" else "md"
            response_path = out_root / f"{model.label}__r{repeat_idx}.{ext}"
            try:
                response_path.write_text(raw_text or f"<!-- ERROR: {error or 'no response'} -->",
                                         encoding="utf-8")
            except Exception:
                pass

            prompt_tokens = sum(count_tokens(m.get("content", "")) for m in messages)
            completion_tokens = count_tokens(raw_text)

            # Auto-rubric
            if spec.task == "plan":
                auto = score_plan_output(
                    raw_text or "",
                    required_ops=spec.rubric_required_ops,
                    min_steps=spec.rubric_min_steps,
                    min_gold_steps=spec.rubric_min_gold_steps,
                )
            else:
                auto = score_narrative_output(raw_text or "")

            # Judge — only score successful, non-empty trials.
            judge = None
            if spec.judge.enabled and raw_text and not error:
                judge = judge_output(spec.judge, requirement=judge_input, response_text=raw_text)

            trials.append(TrialResult(
                label=model.label,
                model_id=model.id,
                repeat_idx=repeat_idx,
                wall_seconds=round(wall, 4),
                cpu_seconds=round(sampler.cpu_seconds, 4) if sampler else 0.0,
                cpu_percent_mean=sampler.cpu_percent_mean if sampler else 0.0,
                rss_mb_peak=sampler.rss_peak_mb if sampler else 0.0,
                rss_mb_delta=round(
                    (sampler.rss_peak_mb - sampler.baseline_rss_mb), 2
                ) if sampler else 0.0,
                prompt_tokens=prompt_tokens,
                completion_tokens=completion_tokens,
                response_chars=len(raw_text or ""),
                response_path=str(response_path),
                cost_usd=trial_cost(
                    model=model, prompt_tokens=prompt_tokens,
                    completion_tokens=completion_tokens, wall_seconds=wall,
                ),
                auto_scores=auto,
                judge_score=judge,
                error=error,
            ))

    finished_at = datetime.utcnow().isoformat() + "Z"
    result = ComparisonResult(
        spec_id=spec.id, spec_name=spec.name, task=spec.task,
        workspace=spec.workspace, output_dir=str(out_root),
        started_at=started_at, finished_at=finished_at, trials=trials,
    )
    # Write the structured report alongside per-trial artifacts.
    (out_root / "results.json").write_text(
        json.dumps(result.to_dict(), indent=2, default=str), encoding="utf-8",
    )
    (out_root / "spec.snapshot.json").write_text(
        spec.model_dump_json(indent=2), encoding="utf-8",
    )
    return result
