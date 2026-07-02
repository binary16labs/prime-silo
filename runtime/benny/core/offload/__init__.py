"""Local Offload Orchestrator (ADR-004).

Routes the bulk of *execution* to the local model (Benny) so a planning agent
(Claude) spends its tokens on strategy and adjudication — not boilerplate. The
planner authors a compact ``aamp.offload_task/1`` manifest; Benny executes; a
deterministic + LLM-judge gate evaluates locally; the planner reads back only a
compact digest and is escalated to only on failure or ambiguity.

Public surface:

- :func:`benny.core.offload.manifest.load_manifest` / ``validate_manifest``
- :func:`benny.core.offload.router.classify`
- :func:`benny.core.offload.orchestrator.run_task` (async)
- :class:`benny.core.offload.ledger.Ledger`
"""

from .manifest import ManifestError, OffloadManifest, load_manifest, validate_manifest
from .router import RouterDecision, classify

__all__ = [
    "OffloadManifest",
    "ManifestError",
    "load_manifest",
    "validate_manifest",
    "classify",
    "RouterDecision",
]
