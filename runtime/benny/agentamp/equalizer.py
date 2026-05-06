"""AAMP-001 Phase 5 — Equalizer panel + manifest write path.

Public API
----------
  EQ_ALLOWED_PATHS
      Frozenset of ``SwarmManifest`` JSON-path patterns that the equalizer may
      edit.  Paths are dot-notation strings; ``tasks[*].*`` is a wildcard that
      matches any per-task field (AAMP-F9).

  EqKnob
      A single equalizer knob: the target path, the new value, and whether the
      knob is locked across runs (AAMP-F10).

  EqManifest
      Ordered list of knobs loaded from ``eq.manifest.json`` inside a skin pack
      (AAMP-F9).

  EqLock
      Persistent lock state written to ``${BENNY_HOME}/agentamp/user/eq.json``
      (AAMP-F10).  Maps path → locked bool.

  validate_knob_path(path) -> None
      Raise :exc:`EqPathNotAllowed` if *path* is not in the allow-list
      (AAMP-F9, AAMP-SEC5).

  EqWriteResult
      Value returned by :func:`apply_eq_write`: the updated manifest dict,
      the new signature, and the previous_signatures list (AAMP-COMP2).

  apply_eq_write(manifest_dict, knobs, *, workspace, benny_home,
                 policy_evaluator, ledger_dir, ledger_secret,
                 persona, task_ids) -> EqWriteResult
      Apply *knobs* to *manifest_dict*, evaluate policy (AAMP-SEC5), sign the
      result, record a ledger entry (AAMP-COMP1), and preserve the previous
      signature (AAMP-COMP2).

Requirements covered
--------------------
  F9     PUT /agentamp/eq — allow-list validation, draft→sign→persist.
  F10    Per-task picker (tasks[*].*); knob lock persisted to eq.json.
  SEC5   policy.evaluate(aamp.eq_write) — denial pauses for HITL.
  COMP1  Every equalizer write appended to the AOS-001 ledger.
  COMP2  Previous manifest signature preserved in EqWriteResult.previous_signatures.

Dependencies: pydantic, stdlib (hashlib, json, pathlib), benny.governance.*,
              benny.agentamp.signing, benny.agentamp.contracts.
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field

from .contracts import SkinSignature
from .signing import sign_skin_pack

# Governance imports are deferred to function-call time to avoid pulling in
# openlineage (optional heavy dep) at module import time.  The concrete types
# are still referenced in type annotations below — those are strings in
# TYPE_CHECKING blocks so they stay annotation-only.
from typing import TYPE_CHECKING

if TYPE_CHECKING:  # pragma: no cover
    from ..governance.ledger import LedgerEntry
    from ..governance.policy import PolicyEvaluator


# ---------------------------------------------------------------------------
# Allow-list
# ---------------------------------------------------------------------------

# Exact config-level knob paths (dot-notation from SwarmManifest root)
_CONFIG_PATHS: frozenset[str] = frozenset({
    "config.model",
    "config.max_concurrency",
    "config.max_depth",
    "config.handover_summary_limit",
    "config.allow_swarm",
    "config.skills_allowed",
    "config.model_per_persona",
})

# Regex for per-task knob paths: tasks[<index or *>].<field>
_TASK_PATH_RE = re.compile(
    r"^tasks\[(\d+|\*)\]\.(assigned_model|complexity|deterministic|estimated_tokens)$"
)

# Exposed for tests / documentation
EQ_ALLOWED_PATHS: frozenset[str] = frozenset(
    _CONFIG_PATHS
    | {
        "tasks[*].assigned_model",
        "tasks[*].complexity",
        "tasks[*].deterministic",
        "tasks[*].estimated_tokens",
    }
)


# ---------------------------------------------------------------------------
# Exceptions
# ---------------------------------------------------------------------------


class EqPathNotAllowed(ValueError):
    """Raised when a knob path is not in the equalizer allow-list (AAMP-F9)."""


# ---------------------------------------------------------------------------
# Data models
# ---------------------------------------------------------------------------


class EqKnob(BaseModel):
    """A single equalizer knob (AAMP-F9, AAMP-F10).

    Parameters
    ----------
    path:
        Dot-notation path into the SwarmManifest.  Must be in the
        :data:`EQ_ALLOWED_PATHS` allow-list.
    value:
        The new value to apply.  JSON-serialisable.
    locked:
        If ``True`` the knob is pinned across runs; its value is persisted
        to ``${BENNY_HOME}/agentamp/user/eq.json`` (AAMP-F10).
    """

    path: str
    value: Any
    locked: bool = False


class EqManifest(BaseModel):
    """The ``eq.manifest.json`` loaded from a skin pack (AAMP-F9).

    A skin author lists the knobs they want to expose in the equalizer panel.
    The panel renders a form from this list; user edits are posted to the
    ``/agentamp/eq`` endpoint.
    """

    schema_version: str = "1.0"
    skin_id: str = ""
    knobs: List[EqKnob] = Field(default_factory=list)


class EqLock(BaseModel):
    """Persistent knob-lock state stored under ``${BENNY_HOME}/agentamp/user/eq.json``
    (AAMP-F10).

    Maps ``path → locked`` so the UI can re-render the lock affordance after a
    reload without re-reading the full skin pack.
    """

    locks: Dict[str, bool] = Field(default_factory=dict)


# ---------------------------------------------------------------------------
# EqWriteResult
# ---------------------------------------------------------------------------


@dataclass
class EqWriteResult:
    """Return value of :func:`apply_eq_write` (AAMP-F9, AAMP-COMP2).

    Attributes
    ----------
    updated_manifest:
        The mutated SwarmManifest dict with the new ``signature`` field.
    new_signature:
        The :class:`~benny.agentamp.contracts.SkinSignature`-compatible dict
        written into ``updated_manifest["signature"]``.
    previous_signatures:
        The list of prior signatures preserved for audit (AAMP-COMP2).
        Each entry is a plain dict: ``{"value": ..., "signed_at": ...,
        "algorithm": ...}``.
    ledger_seq:
        The monotonic sequence number assigned by the ledger (AAMP-COMP1).
    """

    updated_manifest: Dict[str, Any]
    new_signature: Dict[str, Any]
    previous_signatures: List[Dict[str, Any]]
    ledger_seq: int


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------


def validate_knob_path(path: str) -> None:
    """Raise :exc:`EqPathNotAllowed` if *path* is not in the allow-list.

    Accepts both exact config paths (``config.model``) and per-task patterns
    of the form ``tasks[<int>].<field>`` or ``tasks[*].<field>`` (AAMP-F9).
    """
    if path in _CONFIG_PATHS:
        return
    if _TASK_PATH_RE.match(path):
        return
    raise EqPathNotAllowed(
        f"Equalizer path {path!r} is not in the allow-list. "
        f"Allowed paths: {sorted(EQ_ALLOWED_PATHS)}"
    )


# ---------------------------------------------------------------------------
# Path application helpers
# ---------------------------------------------------------------------------


def _apply_path(manifest: Dict[str, Any], path: str, value: Any) -> None:
    """Mutate *manifest* by setting *value* at *path* (in-place).

    Handles:
      ``config.<field>``          → manifest["config"][<field>] = value
      ``tasks[N].<field>``        → manifest["plan"]["tasks"][N][<field>] = value
      ``tasks[*].<field>``        → all tasks get the value
    """
    if path.startswith("config."):
        key = path[len("config."):]
        cfg = manifest.setdefault("config", {})
        cfg[key] = value
        return

    m = _TASK_PATH_RE.match(path)
    if m:
        idx_str, task_field = m.group(1), m.group(2)
        tasks: List[Dict[str, Any]] = (
            manifest.get("plan", {}).get("tasks", [])
        )
        if idx_str == "*":
            for task in tasks:
                task[task_field] = value
        else:
            idx = int(idx_str)
            if 0 <= idx < len(tasks):
                tasks[idx][task_field] = value
        return

    raise EqPathNotAllowed(f"Cannot apply path {path!r} — not in allow-list")


# ---------------------------------------------------------------------------
# Lock persistence
# ---------------------------------------------------------------------------

_EQ_USER_FILE = "agentamp/user/eq.json"


def _load_eq_lock(benny_home: Path) -> EqLock:
    p = benny_home / _EQ_USER_FILE
    if p.exists():
        try:
            return EqLock.model_validate_json(p.read_text(encoding="utf-8"))
        except Exception:
            pass
    return EqLock()


def _save_eq_lock(lock: EqLock, benny_home: Path) -> None:
    p = benny_home / _EQ_USER_FILE
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(lock.model_dump_json(indent=2), encoding="utf-8")


# ---------------------------------------------------------------------------
# Main write path
# ---------------------------------------------------------------------------

_DEFAULT_LEDGER_SECRET = b"benny-aamp-ledger-dev-key-do-not-use-in-prod"


def apply_eq_write(
    manifest_dict: Dict[str, Any],
    knobs: List[EqKnob],
    *,
    workspace: str = "default",
    benny_home: Optional[Path] = None,
    policy_evaluator: Any = None,
    ledger_dir: Optional[Path] = None,
    ledger_secret: Optional[bytes] = None,
    persona: str = "aamp:user",
    task_ids: Optional[List[str]] = None,
) -> EqWriteResult:
    """Apply equalizer *knobs* to *manifest_dict* with full governance.

    Steps (in order):
    1. Validate each knob path against the allow-list (AAMP-F9).
    2. Evaluate ``aamp.eq_write`` policy — raise :exc:`PolicyDeniedError` if
       denied (AAMP-SEC5).
    3. Capture the previous ``signature`` for audit (AAMP-COMP2).
    4. Apply each knob to the manifest dict (in-place copy).
    5. Sign the new manifest (AAMP-F9).
    6. Persist locked knobs to ``eq.json`` (AAMP-F10).
    7. Append a ledger entry (AAMP-COMP1).
    8. Return :class:`EqWriteResult`.

    Parameters
    ----------
    manifest_dict:
        Plain dict representation of the SwarmManifest to edit.  Not mutated;
        a shallow copy is made internally.
    knobs:
        List of :class:`EqKnob` objects to apply.
    workspace:
        Active workspace name — forwarded to policy evaluation.
    benny_home:
        Path to ``$BENNY_HOME``.  Defaults to ``$BENNY_HOME`` env var or
        ``~/.benny``.
    policy_evaluator:
        A configured :class:`~benny.governance.policy.PolicyEvaluator`.  If
        omitted a permissive warn-mode evaluator is built with the EQ write
        tool in the allow-list for the ``aamp:user`` persona.
    ledger_dir:
        Directory for the audit ledger.  Defaults to
        ``$BENNY_HOME/agentamp/ledger``.
    ledger_secret:
        HMAC secret for the ledger chain.  Defaults to the dev key.
    persona:
        Persona making the edit (default ``"aamp:user"``).
    task_ids:
        When knobs contain ``tasks[*].*`` paths and this list is non-empty,
        only the tasks whose IDs appear in *task_ids* are updated (per-task
        picker — AAMP-F10).
    """
    import os

    # Deferred governance imports — avoids pulling in openlineage at module load
    from ..governance.ledger import LedgerEntry, append_entry  # noqa: PLC0415
    from ..governance.policy import (  # noqa: PLC0415
        AAMP_INTENT_EQ_WRITE,
        AAMP_TOOL_EQ_WRITE,
        PolicyDecision,
        PolicyDeniedError,
        PolicyEvaluator,
    )

    _benny_home = benny_home or Path(os.environ.get("BENNY_HOME", Path.home() / ".benny"))

    # 1. Validate all paths up-front
    for knob in knobs:
        validate_knob_path(knob.path)

    # 2. Policy check (AAMP-SEC5)
    _evaluator = policy_evaluator or PolicyEvaluator(
        mode="enforce",
        auto_approve_writes=False,
        allowed_tools_per_persona={persona: [AAMP_TOOL_EQ_WRITE]},
    )
    decision = _evaluator.evaluate(
        intent=AAMP_INTENT_EQ_WRITE,
        tool=AAMP_TOOL_EQ_WRITE,
        persona=persona,
        workspace=workspace,
    )
    if decision == PolicyDecision.DENIED:
        raise PolicyDeniedError(
            f"Policy denied [{persona}] → '{AAMP_TOOL_EQ_WRITE}' "
            f"for workspace {workspace!r}"
        )

    # 3. Capture previous signature (AAMP-COMP2)
    old_sig = manifest_dict.get("signature")
    previous_signatures: List[Dict[str, Any]] = []
    if old_sig is not None:
        if isinstance(old_sig, dict):
            previous_signatures.append(old_sig)
        else:
            previous_signatures.append({"raw": str(old_sig)})

    # 4. Apply knobs to a copy
    updated = json.loads(json.dumps(manifest_dict))  # deep copy via JSON round-trip

    for knob in knobs:
        path = knob.path
        value = knob.value

        # Per-task picker: if task_ids are given and path is tasks[*].*, filter
        if task_ids and _TASK_PATH_RE.match(path):
            idx_str = _TASK_PATH_RE.match(path).group(1)  # type: ignore[union-attr]
            task_field = _TASK_PATH_RE.match(path).group(2)  # type: ignore[union-attr]
            if idx_str == "*":
                tasks = updated.get("plan", {}).get("tasks", [])
                for task in tasks:
                    if task.get("id") in task_ids:
                        task[task_field] = value
            else:
                _apply_path(updated, path, value)
        else:
            _apply_path(updated, path, value)

    # 5. Sign (AAMP-F9)
    # We reuse sign_skin_pack which strips the "signature" field before signing,
    # making round-trips stable.
    new_sig: SkinSignature = sign_skin_pack(json.dumps(updated))
    new_sig_dict = new_sig.model_dump()
    updated["signature"] = new_sig_dict

    # 6. Persist locked knobs (AAMP-F10)
    locked_knobs = [k for k in knobs if k.locked]
    if locked_knobs:
        eq_lock = _load_eq_lock(_benny_home)
        for k in locked_knobs:
            eq_lock.locks[k.path] = True
        _save_eq_lock(eq_lock, _benny_home)

    # 7. Ledger entry (AAMP-COMP1)
    _ledger_dir = ledger_dir or (_benny_home / "agentamp" / "ledger")
    _secret = ledger_secret or _DEFAULT_LEDGER_SECRET

    # Build stable hashes for the ledger record
    action_descriptor = json.dumps(
        {"action": "eq_write", "paths": [k.path for k in knobs], "workspace": workspace},
        sort_keys=True,
        separators=(",", ":"),
    )
    prompt_hash = hashlib.sha256(action_descriptor.encode()).hexdigest()
    diff_payload = json.dumps(
        {"before_sig": str(old_sig), "after_sig": new_sig_dict.get("value", "")},
        sort_keys=True,
        separators=(",", ":"),
    )
    diff_hash = hashlib.sha256(diff_payload.encode()).hexdigest()

    entry = LedgerEntry(
        prompt_hash=prompt_hash,
        diff_hash=diff_hash,
        persona=persona,
        model="aamp:equalizer",
        model_hash="",
        manifest_sig=new_sig_dict.get("value", ""),
    )
    entry = append_entry(entry, ledger_dir=_ledger_dir, secret=_secret)

    return EqWriteResult(
        updated_manifest=updated,
        new_signature=new_sig_dict,
        previous_signatures=previous_signatures,
        ledger_seq=entry.seq,
    )
