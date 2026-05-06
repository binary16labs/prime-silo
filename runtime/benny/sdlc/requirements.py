"""AOS-001 Phase 6 — Requirements Analyst persona.

Public API
----------
  generate_prd(requirement, *, model="local_lemonade") → tuple[dict, str]
      Calls the requirements_analyst persona via _do_call_model() to produce
      a PRD dict + Gherkin feature text.
      The PRD is validated against schemas/aos/prd_v1.schema.json (AOS-F22).
      Returns (prd_dict, gherkin_feature_text).

  validate_prd(prd_dict) → None
      Raises PrdValidationError if the dict does not satisfy prd_v1.schema.json.

  prd_to_gherkin(prd_dict) → str
      Converts a validated PRD dict to Gherkin feature file text.

  PrdValidationError
      Raised when PRD JSON fails schema validation (AOS-F22).

  _do_call_model(model, messages) → str
      Thin synchronous wrapper around call_model() — monkeypatch this in tests:
          monkeypatch.setattr("benny.sdlc.requirements._do_call_model", fake_fn)

AOS requirements covered
------------------------
  F20   generate_prd() → (prd_dict, gherkin_text); files written by benny req CLI
  F22   PRD validated against prd_v1.schema.json; PrdValidationError on failure
  NFR3  End-to-end ≤ 2.5 s p95 (LLM mocked in tests via _do_call_model)

Placement note
--------------
Module lives in benny/sdlc/ (not benny/graph/) because benny/graph/__init__.py
eagerly imports langgraph (not installed in the test environment).
All Phase 5–10 AOS modules follow this pattern.

Dependencies: stdlib (json, re, textwrap, pathlib) + jsonschema (already present).
No new top-level dependency is introduced.
"""

from __future__ import annotations

import json
import re
import textwrap
from pathlib import Path
from typing import Optional


# ---------------------------------------------------------------------------
# Schema loading (lazy, module-level cache)
# ---------------------------------------------------------------------------

_PRD_SCHEMA: Optional[dict] = None


def _load_prd_schema() -> dict:
    """Return the parsed prd_v1.schema.json, loading it once on first call."""
    global _PRD_SCHEMA
    if _PRD_SCHEMA is None:
        # Resolve relative to this file: benny/sdlc/ → repo root → schemas/
        schema_path = (
            Path(__file__).parent.parent.parent
            / "schemas"
            / "aos"
            / "prd_v1.schema.json"
        )
        _PRD_SCHEMA = json.loads(schema_path.read_text(encoding="utf-8"))
    return _PRD_SCHEMA


# ---------------------------------------------------------------------------
# Custom exceptions
# ---------------------------------------------------------------------------


class PrdValidationError(ValueError):
    """Raised when a PRD dict fails jsonschema validation against prd_v1.schema.json.

    AOS-F22: Validation failure halts the workflow and emits the ``prd_invalid``
    SSE event.  The benny req CLI surfaces this as an error exit (code 1).
    """


# ---------------------------------------------------------------------------
# Schema validation (AOS-F22)
# ---------------------------------------------------------------------------


def validate_prd(prd: dict) -> None:
    """Validate *prd* against ``schemas/aos/prd_v1.schema.json``.

    Parameters
    ----------
    prd:
        The PRD dict to validate.

    Raises
    ------
    PrdValidationError
        If the PRD does not satisfy the JSON schema.
    """
    import jsonschema  # import here keeps the top-level import list minimal

    schema = _load_prd_schema()
    try:
        jsonschema.validate(prd, schema)
    except jsonschema.ValidationError as exc:
        raise PrdValidationError(
            f"PRD schema validation failed: {exc.message}"
        ) from exc


# ---------------------------------------------------------------------------
# Gherkin generation (AOS-F20)
# ---------------------------------------------------------------------------


def prd_to_gherkin(prd: dict) -> str:
    """Convert a validated PRD dict to Gherkin feature file text.

    One ``Feature:`` block is emitted per feature in the PRD.  Each
    ``bdd_scenarios`` entry inside a feature becomes a ``Scenario:`` block
    with Given / When / Then steps.

    Parameters
    ----------
    prd:
        A validated PRD dict (must pass :func:`validate_prd` without error).

    Returns
    -------
    str
        Gherkin feature file content (UTF-8, LF line endings).
    """
    lines: list[str] = []

    for feature in prd.get("features", []):
        lines.append(f"Feature: {feature['title']}")

        desc = feature.get("description", "")
        if desc:
            for desc_line in textwrap.wrap(desc, width=72):
                lines.append(f"  {desc_line}")

        lines.append("")

        for scenario in feature.get("bdd_scenarios", []):
            scenario_id = scenario.get("id", "unnamed")
            lines.append(f"  Scenario: {scenario_id}")
            lines.append(f"    Given {scenario['given']}")
            lines.append(f"    When  {scenario['when']}")
            lines.append(f"    Then  {scenario['then']}")
            lines.append("")

    return "\n".join(lines).rstrip() + "\n"


# ---------------------------------------------------------------------------
# LLM call (injectable for testing)
# ---------------------------------------------------------------------------


def _do_call_model(model: str, messages: list) -> str:
    """Thin synchronous wrapper around the async ``call_model()`` function.

    In tests, monkeypatch this to avoid real LLM calls::

        monkeypatch.setattr(
            "benny.sdlc.requirements._do_call_model",
            lambda model, messages: json.dumps(my_mock_prd),
        )

    Resolution order
    ~~~~~~~~~~~~~~~~
    Uses ``asyncio.run(call_model(model, messages))`` — the production path.
    ``asyncio.run`` creates a fresh event loop; it cannot be called from within
    an already-running loop (e.g. Jupyter).  In that case, callers should use
    the async ``benny.core.models.call_model`` directly.
    """
    import asyncio

    from benny.core.models import call_model  # lazy import — avoids langgraph chain

    return asyncio.run(call_model(model, messages))


# ---------------------------------------------------------------------------
# Prompt template
# ---------------------------------------------------------------------------

_PRD_SYSTEM_PROMPT = """\
You are a Requirements Analyst. Given a free-text requirement, produce a \
Product Requirements Document (PRD) as a single JSON object.

The JSON MUST contain:
  - "id"       : string — unique identifier, e.g. "PRD-001"
  - "title"    : string — short title for the PRD
  - "features" : array (at least 1 item) — each item is an object with:
      - "id"          : string, e.g. "F-001"
      - "title"       : string
      - "description" : string
      - "priority"    : one of "must" | "should" | "could" | "wont"  (optional)
      - "bdd_scenarios" : array — each item is:
          - "id"    : string, e.g. "BDD-001"
          - "given" : string
          - "when"  : string
          - "then"  : string

Optional top-level fields: "schema_version" (const "1.0"), "source_requirement",
"created_at" (ISO-8601), "stakeholder_mapping", "metadata".

Respond with ONLY the JSON object. No markdown, no code fences, no commentary.\
"""


# ---------------------------------------------------------------------------
# Public API (AOS-F20, AOS-F22, AOS-NFR3)
# ---------------------------------------------------------------------------


def generate_prd(
    requirement: str,
    *,
    model: str = "local_lemonade",
) -> tuple[dict, str]:
    """Generate a PRD and Gherkin feature text from a free-text requirement.

    Steps
    ~~~~~
    1. Build a requirements-analyst prompt (system + user messages).
    2. Call the LLM via :func:`_do_call_model` (monkeypatch-able for testing).
    3. Strip any accidental markdown code-fence wrapping from the response.
    4. Parse the JSON response into a ``dict``.
    5. Validate the PRD against ``prd_v1.schema.json`` (AOS-F22);
       raises :class:`PrdValidationError` on failure.
    6. Convert to Gherkin via :func:`prd_to_gherkin`.
    7. Return ``(prd_dict, gherkin_text)``.

    Parameters
    ----------
    requirement:
        Free-text requirement string (e.g. ``"Build a VRAM-aware worker pool"``).
    model:
        LLM model identifier forwarded to ``_do_call_model``.
        Default: ``"local_lemonade"`` — the offline-safe local model.

    Returns
    -------
    tuple[dict, str]
        ``(prd_dict, gherkin_feature_text)``

    Raises
    ------
    PrdValidationError
        If the LLM response fails PRD schema validation (AOS-F22).
    json.JSONDecodeError
        If the LLM response cannot be parsed as JSON.
    """
    messages = [
        {"role": "system", "content": _PRD_SYSTEM_PROMPT},
        {"role": "user", "content": f"Requirement: {requirement}"},
    ]

    raw = _do_call_model(model, messages)

    # Strip markdown code fences in case the LLM wraps the JSON
    cleaned = re.sub(r"```(?:json)?\s*", "", raw).strip().rstrip("`").strip()

    prd = json.loads(cleaned)

    validate_prd(prd)   # AOS-F22: raises PrdValidationError on schema failure

    gherkin = prd_to_gherkin(prd)

    return prd, gherkin
