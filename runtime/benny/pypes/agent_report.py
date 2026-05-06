"""Agent-driven risk-narrative report (the "v2" reporting layer).

Where the declarative ``benny/pypes/reports.py`` produces the *facts* — tables
of exposures, breaches, and day-over-day moves — this module overlays a
human-quality interpretation on top of them. The agent has a persona ("Senior
Market-Risk Analyst"), a tightly-scoped skill kit, and reads only the gold
artifacts that the deterministic pipeline already produced. It cannot mutate
data — it observes, narrates, and recommends.

This deliberately lives outside the deterministic flow:

* The declarative pipeline still owns lineage, signatures, and every numeric
  fact in the run. It is the source of truth.
* The agent is opt-in (``benny pypes agent-report <run_id>``), runs *after*
  a successful run, and writes a separate ``risk_narrative.md`` artifact
  that quotes the underlying tables verbatim. If the LLM is unavailable
  the rest of the pipeline is unaffected.

The persona is intentionally framework-aware: it knows it is operating
inside Benny, knows the CLP backbone, and is told to cite specific
counterparties / ISINs / segments rather than hand-wave.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from .checkpoints import CheckpointStore
from .engines import get_engine
from .models import EngineType, PypesManifest, RunReceipt

log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# AGENT CONTRACT
# ---------------------------------------------------------------------------


@dataclass
class RiskAnalystAgent:
    """Persona + skill kit for the post-run risk narrative.

    The agent description is sent to the LLM verbatim so the same instance is
    reusable / forkable from tests. Skills are simple labels — they steer the
    model's reasoning ("you may compute concentration ratios", etc.) without
    granting any tool-use rights, which keeps this layer purely advisory.
    """

    name: str = "BennyRiskAnalyst-v2"
    persona: str = (
        "You are a senior market-risk analyst at a global investment bank. "
        "You have spent fifteen years writing morning-pack commentary for the "
        "front-office heads of trading. You read pypes-generated gold reports "
        "(counterparty exposure, product/segment/country concentration, "
        "maturity profile, top risk drivers) and translate them into a tight, "
        "boardroom-ready narrative. You cite specific counterparties, ISINs, "
        "segments and absolute USD numbers — never vague qualifiers."
    )
    skills: List[str] = field(
        default_factory=lambda: [
            "counterparty-concentration",
            "product-mix-attribution",
            "country/sovereign-exposure",
            "maturity-bucketing",
            "DV01/Vega risk-driver-attribution",
            "day-over-day movement narrative",
            "threshold-breach commentary",
            "regulatory framing (BCBS-239 / FRTB)",
        ]
    )
    framework_context: str = (
        "You are running inside Benny — a local-first AI orchestration platform. "
        "The numeric facts you receive came from a signed pypes RunReceipt; "
        "treat them as authoritative and never invent values. "
        "Respect the BCBS-239 and FRTB compliance tags on the manifest."
    )
    output_format: str = (
        "Output a Markdown document with these sections in this order:\n"
        "  1. **Headline** (2-3 sentence executive read)\n"
        "  2. **Top counterparty exposures** (5-8 bullets, each citing the\n"
        "     counterparty id and the USD figure)\n"
        "  3. **Concentration callouts** (product / segment / country)\n"
        "  4. **Top risk drivers** (DV01, vega) with named counterparties\n"
        "  5. **Day-over-day movement** (highlight any 25%+ movers)\n"
        "  6. **Threshold breaches** (only if any were flagged)\n"
        "  7. **Recommended actions** (3-5 numbered, each tied to a fact above)\n"
        "Cite exact USD values. Do not include disclaimers. No emojis."
    )


# ---------------------------------------------------------------------------
# PUBLIC ENTRY
# ---------------------------------------------------------------------------


def generate_risk_narrative(
    *,
    workspace_root: Path,
    run_id: str,
    model: Optional[str] = None,
    agent: Optional[RiskAnalystAgent] = None,
    out_path: Optional[Path] = None,
    temperature: float = 0.3,
    max_tokens: int = 2400,
) -> Tuple[str, Path, Dict[str, Any]]:
    """Run the risk-analyst agent against a completed pypes run.

    Returns
    -------
    (markdown, written_path, meta)
        ``markdown`` is the rendered narrative; ``written_path`` is where it
        was persisted (under ``runs/pypes-<id>/reports/risk_narrative.md``
        unless ``out_path`` is supplied); ``meta`` summarises the model
        invocation for transcript logging.
    """
    agent = agent or RiskAnalystAgent()

    run_dir = workspace_root / "runs" / f"pypes-{run_id}"
    if not run_dir.exists():
        raise FileNotFoundError(f"Run directory not found: {run_dir}")

    receipt_path = run_dir / "receipt.json"
    if not receipt_path.exists():
        raise FileNotFoundError(f"Receipt not found in run dir: {receipt_path}")
    receipt = RunReceipt.model_validate_json(receipt_path.read_text(encoding="utf-8"))

    manifest = _load_run_manifest(run_dir)
    if manifest is None:
        raise FileNotFoundError(f"Manifest snapshot missing for run {run_id}")

    facts = _collect_facts(run_dir, manifest, receipt)

    resolved_model = _resolve_model(model, manifest.workspace)

    messages = _build_messages(agent, manifest, receipt, facts)
    raw = _call_llm(resolved_model, messages, temperature, max_tokens)

    markdown = _wrap_markdown(agent, manifest, receipt, raw, resolved_model)

    out = out_path or (run_dir / "reports" / "risk_narrative.md")
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(markdown, encoding="utf-8")

    meta = {
        "model": resolved_model,
        "agent": agent.name,
        "run_id": run_id,
        "tables_consumed": list(facts.keys()),
        "raw_chars": len(raw),
        "written": str(out),
    }
    return markdown, out, meta


# ---------------------------------------------------------------------------
# FACT COLLECTION  (read gold checkpoints + breach checks; never the wire-level CSV)
# ---------------------------------------------------------------------------


_GOLD_TOPN = 12  # cap per table to keep prompts tight


def _collect_facts(
    run_dir: Path, manifest: PypesManifest, receipt: RunReceipt
) -> Dict[str, Dict[str, Any]]:
    """Read the gold checkpoints + breach checks and pack them as JSON-able dicts."""
    store = CheckpointStore(run_dir)
    engine = get_engine(EngineType.PANDAS)

    facts: Dict[str, Dict[str, Any]] = {}

    for step in manifest.steps:
        if step.stage.value != "gold":
            continue
        if not store.has(step.id):
            continue
        try:
            df = store.read(engine, step.id)
        except Exception as exc:  # pragma: no cover — best effort
            log.warning("agent_report: cannot read %s (%s)", step.id, exc)
            continue
        rows = engine.to_records(df, limit=_GOLD_TOPN)
        cols = engine.columns(df)
        facts[step.id] = {
            "stage": step.stage.value,
            "row_count": engine.row_count(df),
            "columns": cols,
            "top_rows": rows,
            "description": step.description,
            "clp_binding": step.clp_binding or {},
        }

    # Breach roll-up directly off the receipt
    breaches: List[Dict[str, Any]] = []
    for step_id, vr in receipt.step_results.items():
        for check in (vr.checks or []):
            if check.get("status") == "FAILED":
                breaches.append({"step": step_id, **check})
    if breaches:
        facts["__threshold_breaches__"] = {"breaches": breaches[:25]}

    return facts


# ---------------------------------------------------------------------------
# PROMPT ASSEMBLY
# ---------------------------------------------------------------------------


def _build_messages(
    agent: RiskAnalystAgent,
    manifest: PypesManifest,
    receipt: RunReceipt,
    facts: Dict[str, Dict[str, Any]],
) -> List[Dict[str, str]]:
    skills_block = "\n".join(f"  - {s}" for s in agent.skills)

    system = (
        f"{agent.persona}\n\n"
        f"FRAMEWORK CONTEXT:\n{agent.framework_context}\n\n"
        f"AUTHORISED SKILLS:\n{skills_block}\n\n"
        f"OUTPUT CONTRACT:\n{agent.output_format}"
    )

    facts_json = json.dumps(facts, indent=2, default=str)
    # Soft-cap the facts payload so we don't blow context windows on huge runs.
    # Defaults to 5000 chars to fit small local models (e.g. qwen3-tk-4b-FLM,
    # which truncates at ~8k context). Override with
    # ``BENNY_PYPES_FACTS_CHAR_BUDGET`` when running on a roomier model.
    budget = int(os.environ.get("BENNY_PYPES_FACTS_CHAR_BUDGET", "5000"))
    if len(facts_json) > budget:
        facts_json = (
            facts_json[:budget]
            + f"\n... [truncated to {budget} chars for local-model context window]"
        )

    governance = manifest.governance
    user = (
        f"# Run under analysis\n"
        f"- Manifest: `{manifest.id}` ({manifest.name})\n"
        f"- Workspace: `{manifest.workspace}`\n"
        f"- Run id: `{receipt.run_id}`\n"
        f"- Run status: `{receipt.status}` "
        f"(duration {receipt.duration_ms or '?'} ms)\n"
        f"- Compliance tags: {', '.join(governance.compliance_tags) or '-'}\n"
        f"- Owner: {governance.owner or '-'}\n"
        f"- Criticality: {governance.criticality}\n\n"
        f"# Gold-layer facts (top {_GOLD_TOPN} rows per table)\n\n"
        f"```json\n{facts_json}\n```\n\n"
        "Author the risk narrative now using the OUTPUT CONTRACT above. "
        "Quote concrete counterparty ids, ISINs, segments and USD numbers from "
        "the JSON. Do not invent rows. If a section has no supporting data, "
        "say so explicitly rather than fabricating examples."
    )

    return [
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ]


def _wrap_markdown(
    agent: RiskAnalystAgent,
    manifest: PypesManifest,
    receipt: RunReceipt,
    body: str,
    model: str,
) -> str:
    stamp = datetime.utcnow().isoformat() + "Z"
    header = (
        f"# Risk Narrative — {manifest.name}\n\n"
        f"- **Agent:** `{agent.name}` (sandboxed v2 layer; advisory only)\n"
        f"- **Model:** `{model}`\n"
        f"- **Run id:** `{receipt.run_id}`\n"
        f"- **Workspace:** `{manifest.workspace}`\n"
        f"- **Compliance:** {', '.join(manifest.governance.compliance_tags) or '-'}\n"
        f"- **Generated:** {stamp}\n\n"
        f"> Numeric facts in this narrative were drawn from the signed pypes\n"
        f"> RunReceipt at `runs/pypes-{receipt.run_id}/receipt.json`. The agent\n"
        f"> only **reads** gold artifacts — it never mutates data or rewrites\n"
        f"> the deterministic pipeline.\n\n"
        f"---\n\n"
    )
    return header + body.strip() + "\n"


# ---------------------------------------------------------------------------
# HELPERS
# ---------------------------------------------------------------------------


def _resolve_model(explicit: Optional[str], workspace: str) -> str:
    if explicit:
        return explicit
    env = os.environ.get("BENNY_DEFAULT_MODEL")
    if env:
        return env
    mid = ""
    try:
        from ..core.models import get_active_model

        mid = asyncio.run(get_active_model(workspace_id=workspace, role="chat"))
    except Exception as exc:
        log.debug("agent_report: get_active_model failed (%s)", exc)
    # ``get_active_model`` falls back to ``lemonade/default`` when its
    # heartbeat probe URL math is wrong for ``/api/v1`` bases. Replace the
    # placeholder with a real Lemonade model id by probing the live endpoint.
    if not mid or mid.endswith("/default"):
        from .agent_chat import _first_chat_capable_lemonade_model, _first_ollama_model

        real = _first_chat_capable_lemonade_model()
        if real:
            return f"lemonade/{real}"
        real = _first_ollama_model()
        if real:
            return f"ollama/{real}"
    return mid or "ollama/llama3.1"


def _call_llm(
    model: str, messages: List[Dict[str, str]], temperature: float, max_tokens: int
) -> str:
    from ..core.models import call_model

    coro = call_model(
        model=model, messages=messages, temperature=temperature, max_tokens=max_tokens
    )
    try:
        return asyncio.run(coro)
    except RuntimeError as exc:
        if "asyncio.run() cannot be called" in str(exc):
            loop = asyncio.new_event_loop()
            try:
                return loop.run_until_complete(coro)
            finally:
                loop.close()
        raise


def _load_run_manifest(run_dir: Path) -> Optional[PypesManifest]:
    snap = run_dir / "manifest_snapshot.json"
    if not snap.exists():
        return None
    return PypesManifest.model_validate_json(snap.read_text(encoding="utf-8"))
