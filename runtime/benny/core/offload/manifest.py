"""``aamp.offload_task/1`` manifest model + dependency-free validation.

We deliberately avoid a ``jsonschema`` runtime dependency — the contract is
small and the checks here mirror ``manifests/offload/task.manifest.schema.json``
exactly. Keep the two in sync.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional

FORMAT = "aamp.offload_task/1"
_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{2,63}$")
_AC_ID_RE = re.compile(r"^ac[0-9]+$")
_VALID_TIERS = {"green", "yellow", "red"}
_VALID_MODES = {"shell", "generate"}
_VALID_ESCALATION = {"on_fail", "on_low_confidence", "never", "always"}


class ManifestError(ValueError):
    """Raised when a manifest violates the contract. Message lists every issue."""


@dataclass
class AcceptanceCriterion:
    id: str
    statement: str
    verify: str = ""


@dataclass
class OffloadManifest:
    id: str
    intent: str
    acceptance_criteria: List[AcceptanceCriterion]
    risk_tier: str
    context_pointers: List[str] = field(default_factory=list)
    executor: Dict[str, Any] = field(default_factory=dict)
    eval_plan: Dict[str, Any] = field(default_factory=dict)
    allowed_paths: List[str] = field(default_factory=list)
    budget: Dict[str, Any] = field(default_factory=dict)
    escalation_policy: str = "on_fail"
    workspace: str = "default"
    raw: Dict[str, Any] = field(default_factory=dict)

    # -- convenience accessors with schema defaults applied --------------------
    @property
    def executor_mode(self) -> str:
        return self.executor.get("mode", "generate")

    @property
    def executor_model(self) -> str:
        return self.executor.get("model", "") or ""

    @property
    def judge_enabled(self) -> bool:
        return bool(self.eval_plan.get("judge", {}).get("enabled", True))

    @property
    def judge_model(self) -> str:
        return self.eval_plan.get("judge", {}).get("model", "") or ""

    @property
    def judge_threshold(self) -> float:
        return float(self.eval_plan.get("judge", {}).get("pass_threshold", 0.8))

    @property
    def deterministic_checks(self) -> List[str]:
        explicit = list(self.eval_plan.get("deterministic", []))
        # acceptance-criterion verify commands are part of the deterministic gate
        for ac in self.acceptance_criteria:
            if ac.verify and ac.verify not in explicit:
                explicit.append(ac.verify)
        return explicit

    @property
    def max_iterations(self) -> int:
        return int(self.budget.get("max_iterations", 3))

    @property
    def max_seconds(self) -> int:
        return int(self.budget.get("max_seconds", 1800))


def validate_manifest(data: Dict[str, Any]) -> List[str]:
    """Return a list of human-readable problems. Empty list == valid."""
    problems: List[str] = []

    def req(cond: bool, msg: str) -> None:
        if not cond:
            problems.append(msg)

    req(isinstance(data, dict), "manifest must be a JSON object")
    if not isinstance(data, dict):
        return problems

    req(data.get("format") == FORMAT, f"format must be '{FORMAT}'")
    req(isinstance(data.get("id"), str) and bool(_ID_RE.match(data.get("id", ""))),
        "id must match ^[a-z0-9][a-z0-9_-]{2,63}$")
    req(isinstance(data.get("intent"), str) and len(data.get("intent", "")) >= 8,
        "intent must be a string of at least 8 chars")
    req(data.get("risk_tier") in _VALID_TIERS, f"risk_tier must be one of {sorted(_VALID_TIERS)}")

    ac = data.get("acceptance_criteria")
    if not isinstance(ac, list) or not ac:
        problems.append("acceptance_criteria must be a non-empty array")
    else:
        for i, item in enumerate(ac):
            if not isinstance(item, dict):
                problems.append(f"acceptance_criteria[{i}] must be an object")
                continue
            if not _AC_ID_RE.match(str(item.get("id", ""))):
                problems.append(f"acceptance_criteria[{i}].id must match ^ac[0-9]+$")
            if not (isinstance(item.get("statement"), str) and len(item.get("statement", "")) >= 4):
                problems.append(f"acceptance_criteria[{i}].statement must be >=4 chars")

    ex = data.get("executor", {})
    if ex:
        if not isinstance(ex, dict):
            problems.append("executor must be an object")
        elif ex.get("mode", "generate") not in _VALID_MODES:
            problems.append(f"executor.mode must be one of {sorted(_VALID_MODES)}")
        elif ex.get("mode") == "shell" and not ex.get("command"):
            problems.append("executor.mode='shell' requires a command")

    esc = data.get("escalation_policy", "on_fail")
    if esc not in _VALID_ESCALATION:
        problems.append(f"escalation_policy must be one of {sorted(_VALID_ESCALATION)}")

    return problems


def from_dict(data: Dict[str, Any]) -> OffloadManifest:
    problems = validate_manifest(data)
    if problems:
        raise ManifestError("; ".join(problems))
    criteria = [
        AcceptanceCriterion(id=c["id"], statement=c["statement"], verify=c.get("verify", ""))
        for c in data["acceptance_criteria"]
    ]
    return OffloadManifest(
        id=data["id"],
        intent=data["intent"],
        acceptance_criteria=criteria,
        risk_tier=data["risk_tier"],
        context_pointers=list(data.get("context_pointers", [])),
        executor=dict(data.get("executor", {})),
        eval_plan=dict(data.get("eval_plan", {})),
        allowed_paths=list(data.get("allowed_paths", [])),
        budget=dict(data.get("budget", {})),
        escalation_policy=data.get("escalation_policy", "on_fail"),
        workspace=data.get("workspace", "default"),
        raw=data,
    )


def load_manifest(path: str | Path) -> OffloadManifest:
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    return from_dict(data)
