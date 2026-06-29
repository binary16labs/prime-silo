"""Risk-tier router.

Classifies an :class:`OffloadManifest` against ``router.matrix.json``. Core
principle: a task is offloadable iff its acceptance criteria are deterministically
checkable; otherwise it is red and stays with the planner. The router may
**upgrade** a declared tier (green->yellow->red) but never silently downgrades.
"""

from __future__ import annotations

import fnmatch
import json
from dataclasses import dataclass, field
from typing import Any, Dict, List

from .manifest import OffloadManifest
from .paths import router_matrix_path

# Embedded fallback so the router works even if the matrix file is unavailable
# (e.g. a standalone runtime bundle). Kept terse; the file is the source of truth.
_FALLBACK_MATRIX: Dict[str, Any] = {
    "upgrade_signals": {
        "force_red": {
            "path_globs": ["L1/**", "L2/**", "manifests/**", "**/*.sig",
                           "**/manifest_signing*", "**/agent_scope*"],
            "intent_keywords": ["auth", "credential", "secret", "private key",
                                "signing key", "sign manifest", "delete history",
                                "production deploy", "release", "rotate key",
                                "rm -rf", "drop ", "force push"],
        },
        "force_yellow": {
            "intent_keywords": ["migration", "schema change", "public api",
                                "concurrency", "race", "regex"],
        },
    },
    "defaults": {
        # confirmed serving on the operator's Lemonade (2026-06-29); 9b-FLM
        # gives clean code (judge 0.95). GGUF/NPU recipes failed to load there.
        # Override via router.matrix.json.
        "executor_model": "lemonade/qwen3.5-9b-FLM",
        "judge_model": "lemonade/Qwen2.5-0.5B-Instruct-CPU",
        "judge_pass_threshold": 0.8,
        "max_iterations": 3,
    },
}

_TIER_RANK = {"green": 0, "yellow": 1, "red": 2}


@dataclass
class RouterDecision:
    declared_tier: str
    final_tier: str
    upgraded: bool
    escalate_immediately: bool       # red -> never run the executor
    reasons: List[str] = field(default_factory=list)
    defaults: Dict[str, Any] = field(default_factory=dict)


def _load_matrix() -> Dict[str, Any]:
    try:
        return json.loads(router_matrix_path().read_text(encoding="utf-8"))
    except Exception:
        return _FALLBACK_MATRIX


def _max_tier(a: str, b: str) -> str:
    return a if _TIER_RANK[a] >= _TIER_RANK[b] else b


def classify(manifest: OffloadManifest, touched_paths: List[str] | None = None) -> RouterDecision:
    matrix = _load_matrix()
    signals = matrix.get("upgrade_signals", {})
    declared = manifest.risk_tier
    tier = declared
    reasons: List[str] = []

    intent_blob = " ".join(
        [manifest.intent] + [c.statement for c in manifest.acceptance_criteria]
    ).lower()
    paths = list(touched_paths or [])
    paths += list(manifest.allowed_paths)
    paths += list(manifest.context_pointers)
    if manifest.executor_mode == "shell":
        intent_blob += " " + manifest.executor.get("command", "").lower()

    # --- force_red -----------------------------------------------------------
    red = signals.get("force_red", {})
    for kw in red.get("intent_keywords", []):
        if kw.lower() in intent_blob:
            tier = _max_tier(tier, "red")
            reasons.append(f"force_red: intent matches '{kw.strip()}'")
            break
    for glob in red.get("path_globs", []):
        if any(fnmatch.fnmatch(p, glob) for p in paths):
            tier = _max_tier(tier, "red")
            reasons.append(f"force_red: touches guarded path '{glob}'")
            break

    # --- force_yellow --------------------------------------------------------
    if _TIER_RANK[tier] < _TIER_RANK["red"]:
        yellow = signals.get("force_yellow", {})
        for kw in yellow.get("intent_keywords", []):
            if kw.lower() in intent_blob:
                tier = _max_tier(tier, "yellow")
                reasons.append(f"force_yellow: intent matches '{kw}'")
                break
        # a declared-green task whose criteria are not all deterministically
        # checkable cannot stay green — the gate would have nothing to check.
        if declared == "green":
            missing = [c.id for c in manifest.acceptance_criteria if not c.verify]
            has_det_plan = bool(manifest.eval_plan.get("deterministic"))
            if missing and not has_det_plan:
                tier = _max_tier(tier, "yellow")
                reasons.append(
                    f"force_yellow: green criteria without verify ({', '.join(missing)})"
                )

    upgraded = _TIER_RANK[tier] > _TIER_RANK[declared]
    if not reasons:
        reasons.append(f"declared tier '{declared}' accepted")

    return RouterDecision(
        declared_tier=declared,
        final_tier=tier,
        upgraded=upgraded,
        escalate_immediately=(tier == "red"),
        reasons=reasons,
        defaults=matrix.get("defaults", _FALLBACK_MATRIX["defaults"]),
    )
