"""
Model profiles — per-provider, capability-aware model routing config.

Fixes "default-safe thinking": out of the box (no operator toggle), reasoning
models keep emitting hidden <think> chains, so structured tasks (triple
extraction) get unparseable output and the knowledge graph ships empty. A
profile tags each model with a *thinking capability* and the router uses it to
auto-suppress reasoning for synthesis roles — while never touching models that
break when thinking is disabled.

Thinking capability classes:
  - "capable"  — can reason but works fine with /no_think → SAFE to auto-suppress
                 for structured tasks (e.g. Qwen3-8B-Hybrid, deepseek-r1, *-qat).
  - "fragile"  — returns EMPTY when /no_think is injected → NEVER suppress
                 (the FLM family: qwen3.5-9b-FLM, *-FLM). Respects the caveat in
                 models.py that a blanket /no_think breaks these.
  - "none"     — not a reasoning model; suppression is a harmless no-op
                 (instruct/coder/*-it models).

Layering (later wins):
  1. Built-in defaults in this module (always present — ships in benny/core).
  2. Optional repo file  configs/model_profiles.json.
  3. Optional per-workspace override  <workspace>/.benny/model_profiles.json
     (written by the Agents screen — "managed on screen but also a file").

The active profile is selected *per provider* (manifest.provider_profiles or the
file's "providers" map), so different hardware/provider setups can ship distinct
capability tables.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Dict, List, Optional

logger = logging.getLogger(__name__)

# Roles whose output must be structured (JSON/triples) — suppress reasoning here
# for "capable" models by default. Profiles may override per-profile.
DEFAULT_SUPPRESS_ROLES = ["graph_synthesis"]

# Built-in source of truth. The JSON files only *override* this, so the system
# works even when no config file ships (e.g. the assembled runtime bundle).
_BUILTIN: Dict = {
    "schema": "prime-silo.model-profiles/1",
    "suppress_thinking_roles": DEFAULT_SUPPRESS_ROLES,
    "profiles": {
        "default": {
            "description": (
                "Auto-suppress hidden reasoning for synthesis on thinking-capable "
                "models; never suppress fragile FLM models."
            ),
            "models": {
                # capable — reason, but tolerate /no_think → safe to suppress
                "Qwen3-8B-Hybrid": {"thinking": "capable"},
                "DeepSeek-Qwen3-8B-GGUF": {"thinking": "capable"},
                "deepseek-r1": {"thinking": "capable"},
                "deepseek-r1:8b": {"thinking": "capable"},
                "gemma-4-12b-qat": {"thinking": "capable"},
                # fragile — /no_think EMPTIES these → never suppress
                "qwen3.5-9b-FLM": {"thinking": "fragile"},
                "qwen3-tk-4b-FLM": {"thinking": "fragile"},
                "Qwen3-8B-Instruct-FLM": {"thinking": "fragile"},
                "llama3.2-1b-FLM": {"thinking": "fragile"},
                "deepseek-r1-8b-FLM": {"thinking": "fragile"},
                # none — not reasoning models
                "Gemma-4-E4B-it-GGUF": {"thinking": "none"},
                "Gemma-4-26B-A4B-it-GGUF": {"thinking": "none"},
                "Qwen2.5-Coder-7B-Instruct-NPU": {"thinking": "none"},
                "Qwen2.5-0.5B-Instruct-CPU": {"thinking": "none"},
            },
        },
        "always-think": {
            "description": "Never auto-suppress (reasoning-quality / debug mode).",
            "suppress_thinking_roles": [],
            "models": {},
        },
    },
    # provider -> active profile name
    "providers": {
        "lemonade": "default",
        "ollama": "default",
        "fastflowlm": "default",
        "lmstudio": "default",
        "nvidia_nim": "default",
        "litert": "default",
    },
}


def _bare(model: str) -> str:
    """Last path component of a model id, lowercased ('lemonade/Qwen3-8B' -> 'qwen3-8b')."""
    return (model or "").split("/")[-1].strip().lower()


def _deep_merge(base: Dict, over: Dict) -> Dict:
    out = dict(base)
    for k, v in (over or {}).items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _deep_merge(out[k], v)
        else:
            out[k] = v
    return out


def _repo_config_path() -> Path:
    # runtime/configs/model_profiles.json (relative to this file: core/ -> benny/ -> runtime/)
    return Path(__file__).resolve().parents[2] / "configs" / "model_profiles.json"


def _load_json(path: Path) -> Dict:
    try:
        if path.exists():
            return json.loads(path.read_text(encoding="utf-8"))
    except Exception as e:
        logger.warning("model_profiles: could not read %s: %s", path, e)
    return {}


def load_profiles(workspace: Optional[str] = None) -> Dict:
    """Built-in defaults merged with the repo file and (if any) the per-workspace
    override. Not cached on workspace since the override file may change at runtime."""
    data = _deep_merge(_BUILTIN, _load_json(_repo_config_path()))
    if workspace:
        try:
            from .workspace import get_workspace_path

            ws_file = get_workspace_path(workspace) / ".benny" / "model_profiles.json"
            data = _deep_merge(data, _load_json(ws_file))
        except Exception as e:
            logger.debug("model_profiles: workspace override skipped: %s", e)
    return data


def _heuristic_capability(model: str) -> str:
    """Classify an unlisted model conservatively by name."""
    b = _bare(model)
    if "flm" in b:
        return "fragile"  # the /no_think-empties caveat applies to the FLM family
    if any(t in b for t in ("hybrid", "-r1", "r1:", "deepseek-r1", "qat", "think", "reasoning")):
        return "capable"
    if any(t in b for t in ("-it", "instruct", "coder", "-it-")):
        return "none"
    return "none"  # safe default: don't inject /no_think into unknown models


def active_profile_name(provider: str, workspace: Optional[str] = None) -> str:
    data = load_profiles(workspace)
    # manifest provider_profiles overrides the file's providers map
    if workspace:
        try:
            from .workspace import load_manifest

            pp = getattr(load_manifest(workspace), "provider_profiles", {}) or {}
            if pp.get(provider):
                return pp[provider]
        except Exception:
            pass
    return (data.get("providers", {}) or {}).get(provider, "default")


def get_thinking_capability(model: str, provider: str = "", workspace: Optional[str] = None) -> str:
    """Return 'capable' | 'fragile' | 'none' for a model under the active profile."""
    data = load_profiles(workspace)
    profile = data.get("profiles", {}).get(active_profile_name(provider, workspace), {})
    models = profile.get("models", {}) or {}
    bare = _bare(model)
    for key, meta in models.items():
        if _bare(key) == bare:
            return (meta or {}).get("thinking", "none")
    return _heuristic_capability(model)


def suppress_roles(provider: str = "", workspace: Optional[str] = None) -> List[str]:
    data = load_profiles(workspace)
    profile = data.get("profiles", {}).get(active_profile_name(provider, workspace), {})
    if "suppress_thinking_roles" in profile:
        return list(profile["suppress_thinking_roles"] or [])
    return list(data.get("suppress_thinking_roles", DEFAULT_SUPPRESS_ROLES))


def list_profile_names(workspace: Optional[str] = None) -> List[str]:
    return sorted(load_profiles(workspace).get("profiles", {}).keys())


def resolved_capabilities(workspace: Optional[str] = None) -> Dict[str, Dict[str, str]]:
    """For the Agents screen: every model declared across profiles → its thinking
    class under that profile (so the UI can render and edit the capability table)."""
    data = load_profiles(workspace)
    out: Dict[str, Dict[str, str]] = {}
    for pname, profile in data.get("profiles", {}).items():
        out[pname] = {
            model: (meta or {}).get("thinking", "none")
            for model, meta in (profile.get("models", {}) or {}).items()
        }
    return out


def set_workspace_model_capability(
    workspace: str, model: str, thinking: str, profile: str = "default"
) -> Path:
    """Persist an on-screen capability edit to the per-workspace override FILE
    (<workspace>/.benny/model_profiles.json). thinking ∈ capable|fragile|none."""
    if thinking not in ("capable", "fragile", "none"):
        raise ValueError(f"invalid thinking capability: {thinking!r}")
    from .workspace import get_workspace_path

    path = get_workspace_path(workspace) / ".benny" / "model_profiles.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    current = _load_json(path)
    current.setdefault("profiles", {}).setdefault(profile, {}).setdefault("models", {})[model] = {
        "thinking": thinking
    }
    path.write_text(json.dumps(current, indent=2, ensure_ascii=False), encoding="utf-8")
    return path


def should_suppress_thinking(
    model: str,
    actual_model: str,
    workspace: Optional[str],
    role: Optional[str],
    operator_override: Optional[bool] = None,
) -> bool:
    """Central decision: should hidden reasoning be disabled for this call?

    Precedence:
      1. 'fragile' capability  → NEVER suppress (would empty the model).
      2. explicit operator override (model_thinking 'off'/'on') → honour it.
      3. profile default: 'capable' model on a structured/synthesis role → suppress.
      4. otherwise → don't.
    """
    provider = (
        (actual_model or model or "").split("/")[0] if "/" in (actual_model or model or "") else ""
    )
    cap = get_thinking_capability(actual_model or model, provider=provider, workspace=workspace)

    if cap == "fragile":
        if operator_override is True:
            logger.info(
                "model_profiles: ignoring thinking=off for fragile model %r (/no_think empties it)",
                actual_model or model,
            )
        return False

    if operator_override is not None:
        return operator_override

    if cap == "capable" and role and role in suppress_roles(provider, workspace):
        return True
    return False
