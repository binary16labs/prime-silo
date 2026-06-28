"""
Vision describer ladder + multi-model review loop (VIS-001 / ADR-003 Phase 2).

Turns a DocModel visual element (a crop + its caption/context from Phase 0) into a
validated textual **surrogate**, using more than one model so the result is
greater than any single pass:

  1. classify   — illustration | diagram | chart (label + caption heuristics)
  2. describe    — qwen3vl (vision) produces the surrogate from the crop, grounded
                   by the caption + surrounding text
  3. validate    — programmatic check (Mermaid parses / JSON valid) — no hollow success
  4. review      — qwen3-9b (text) cross-checks the surrogate against the document's
                   OWN text, scores it, flags missing/hallucinated parts, proposes a fix
  5. refine      — vision model regenerates given the critique (bounded iterations)
  6. best wins   — highest-scoring VALID surrogate, else a plain caption fallback

All model calls go through ``call_model`` (ADR-001 / VIS-SEC3). The vision and
reviewer models are parameters so the workflow is reusable across documents.
"""
from __future__ import annotations

import logging
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

from .models import call_model
from .vision import vision_message

logger = logging.getLogger(__name__)

DEFAULT_VLM = "lemonade/qwen3vl-it-4b-FLM"
DEFAULT_REVIEWER = "lemonade/qwen3.5-9b-FLM"

# DocItemLabel values that are decorative vs. technical. docling already emits a
# distinct ``chart`` label; everything else under ``picture`` we sub-classify.
_DIAGRAM_HINTS = ("figure", "diagram", "architecture", "cycle", "framework", "model",
                  "flow", "process", "metamodel", "structure", "relationship", "overview")
_CHART_HINTS = ("chart", "graph", "plot", "trend", "distribution", "histogram", "bar ", "pie")


# =============================================================================
# CLASSIFICATION
# =============================================================================


def classify_visual(label: str, caption: str = "") -> str:
    """Decide the treatment type for a visual element.

    ``chart`` (docling label) → chart. Otherwise use caption keywords to tell a
    technical *diagram* from a decorative *illustration*; default to diagram in a
    technical document since that is the high-value case.
    """
    cap = (caption or "").lower()
    if label == "chart" or any(h in cap for h in _CHART_HINTS):
        return "chart"
    if any(h in cap for h in _DIAGRAM_HINTS):
        return "diagram"
    # A captioned "Figure N" in a standards doc is almost always a diagram.
    if re.search(r"\bfig(?:ure)?\b", cap):
        return "diagram"
    return "illustration"


# =============================================================================
# MERMAID EXTRACTION + VALIDATION (programmatic "test the outcome")
# =============================================================================

_MERMAID_HEADERS = (
    "flowchart", "graph", "sequencediagram", "classdiagram", "statediagram",
    "erdiagram", "journey", "gantt", "mindmap", "timeline", "C4Context",
)


def extract_code(text: str, lang: str = "mermaid") -> str:
    """Pull a fenced ``code block (any of ```mermaid / ``` / ```json) or, failing
    that, return the stripped text. Drops <think> blocks local models emit, and —
    for Mermaid — strips the invalid ``#`` comments/notes local models like to add
    (Mermaid comments are ``%%``, and a stray ``# Note:`` line hard-fails mmdc)."""
    if not text:
        return ""
    text = re.sub(r"<think>.*?</think>", "", text, flags=re.DOTALL | re.IGNORECASE).strip()
    m = re.search(rf"```{lang}\s*\n?(.*?)```", text, re.DOTALL | re.IGNORECASE)
    if not m:
        m = re.search(r"```\s*\n?(.*?)```", text, re.DOTALL)
    code = (m.group(1) if m else text).strip()
    if lang == "mermaid":
        code = _sanitize_mermaid(code)
    return code


def _sanitize_mermaid(code: str) -> str:
    """Remove Mermaid-invalid ``#`` comment lines and trailing `` # ...`` inline
    notes (the ``\\s#\\s`` form won't touch a real ``A[C#]`` label)."""
    out = []
    for line in code.splitlines():
        if line.lstrip().startswith("#"):
            continue
        line = re.sub(r"\s+#\s.*$", "", line)  # strip " # note" tails
        if line.strip():
            out.append(line)
    return "\n".join(out).strip()


def validate_mermaid(code: str) -> Tuple[bool, str]:
    """Permissive structural PRE-FILTER for Mermaid source — the authoritative gate
    is ``render_validate_mermaid`` (mmdc). Calibrated against the real renderer: it
    only rejects what definitely will not render (no/empty header, no edges,
    unbalanced subgraph/end, prose instead of code). It deliberately does NOT
    reject things mmdc actually accepts (dotted ids, `A --|x|--> B` labels); those
    are quality concerns handled by the prompt + reviewer, not validity. Returns
    (ok, reason)."""
    if not code or not code.strip():
        return False, "empty"
    lines = [l.rstrip() for l in code.strip().splitlines() if l.strip()]
    header = lines[0].strip().lower()
    if not header.startswith(tuple(h.lower() for h in _MERMAID_HEADERS)):
        return False, f"no valid diagram header (got: {lines[0][:40]!r})"
    body = "\n".join(lines[1:])
    # balanced subgraph/end
    n_sub = len(re.findall(r"^\s*subgraph\b", body, re.MULTILINE))
    n_end = len(re.findall(r"^\s*end\b", body, re.MULTILINE))
    if n_sub != n_end:
        return False, f"unbalanced subgraph/end ({n_sub} vs {n_end})"
    # a flowchart/graph must have at least one edge/connection
    if header.startswith(("flowchart", "graph")):
        if not re.search(r"--|==|-\.|-->|---", body):
            return False, "no edges/connections found"
    # crude prose detector: a non-comment line that reads like a sentence
    for l in lines[1:]:
        s = l.strip()
        if s.startswith("%%"):
            continue
        if s.endswith(".") and " " in s and not re.search(r"[\[\]{}()|>\-=]", s):
            return False, f"prose leaked into diagram: {s[:40]!r}"
    return True, "ok"


def _find_mmdc_cli() -> Optional[str]:
    """Locate the mermaid-cli entry (``cli.js``). Env ``BENNY_MMDC_CLI`` wins;
    otherwise probe the packaging install. Returns None when unavailable (render
    validation is an optional dev/build-time gate, not shipped in the runtime)."""
    env = os.environ.get("BENNY_MMDC_CLI")
    if env and Path(env).exists():
        return env
    here = Path(__file__).resolve()
    for parent in here.parents:
        cand = parent / "packaging" / "node_modules" / "@mermaid-js" / "mermaid-cli" / "src" / "cli.js"
        if cand.exists():
            return str(cand)
    return None


def render_validate_mermaid(code: str, *, out_png: Optional[str] = None, timeout: int = 120) -> Tuple[bool, str, Optional[str]]:
    """Authoritative 'does it render' check: run mermaid-cli (mmdc) to render the
    diagram to PNG. Returns (ok, reason, png_path|None). Falls back to (None-ish)
    when node/mmdc are absent so callers can degrade to structural validation."""
    node = shutil.which("node")
    cli = _find_mmdc_cli()
    if not node or not cli:
        return False, "mmdc-unavailable", None
    tmpdir = Path(tempfile.mkdtemp(prefix="mmdc-"))
    mmd = tmpdir / "d.mmd"
    png = Path(out_png) if out_png else tmpdir / "d.png"
    png.parent.mkdir(parents=True, exist_ok=True)
    mmd.write_text(code, encoding="utf-8")
    try:
        proc = subprocess.run([node, cli, "-i", str(mmd), "-o", str(png)],
                              capture_output=True, text=True, timeout=timeout)
        if proc.returncode == 0 and png.exists() and png.stat().st_size > 0:
            return True, "rendered", str(png)
        err = (proc.stderr or proc.stdout or "").strip().splitlines()
        return False, "render-failed: " + (err[-1][:160] if err else f"exit {proc.returncode}"), None
    except subprocess.TimeoutExpired:
        return False, "render-timeout", None
    except Exception as e:
        return False, f"render-error: {e}", None


def _table_json_to_markdown(table: Dict[str, Any], max_rows: int = 8) -> str:
    cols = table.get("columns", [])
    rows = table.get("rows", [])[:max_rows]
    out = ["| " + " | ".join(str(c) for c in cols) + " |",
           "| " + " | ".join("---" for _ in cols) + " |"]
    for r in rows:
        out.append("| " + " | ".join("" if c is None else str(c) for c in r) + " |")
    return "\n".join(out)


# =============================================================================
# PROMPTS
# =============================================================================

DIAGRAM_PROMPT = """You are converting a TECHNICAL DIAGRAM into Mermaid diagram-as-code.

CONTEXT (caption + surrounding text from the source document):
{context}

Rules:
- Output ONLY Mermaid code, nothing else. Start with a valid header (flowchart TD / flowchart LR / graph TD).
- Give each node a SHORT id that is plain alphanumeric with NO dots and NO spaces (e.g. P, A, B, RM).
- Define each node's label EXACTLY ONCE as `id[Label]` using the EXACT text from the image, then connect using ids ONLY.
  CORRECT:   A[Architecture Vision]\n             A --> B\n             RM[Requirements Management]\n             RM <--> A
  WRONG:     A.[Architecture Vision] --> B.[Business Architecture]   (dotted ids, label repeated)
- Capture EVERY labelled box/node and EVERY arrow, including direction and edge labels (`A -->|label| B`).
- For a hub/center node connected to all others, define it once and link it to each id.
- Use `subgraph Name ... end` for visually grouped/nested containers.
- Do NOT invent nodes not in the image. Do NOT add prose or explanation.

Mermaid:"""

ILLUSTRATION_PROMPT = """Describe this image in 1-2 factual sentences for a document index.
CONTEXT: {context}
Be concrete and specific; do not speculate. Description:"""

CHART_PROMPT = """You are extracting data from a CHART. Output ONLY a JSON object:
{{"chart_type": "...", "title": "...", "axes": {{"x": "...", "y": "..."}}, "series": [{{"name": "...", "points": [[x, y], ...]}}], "description": "one sentence"}}
CONTEXT: {context}
JSON:"""

REVIEW_PROMPT = """You are a meticulous reviewer of diagram-as-code. A vision model converted a
technical diagram into Mermaid. You CANNOT see the image, but you have the diagram's
caption and the surrounding document text, which describe what the diagram contains.

DIAGRAM CAPTION + CONTEXT:
{context}

CANDIDATE MERMAID:
{mermaid}

Assess strictly and reply in this EXACT XML form (no prose outside it):
<review>
  <valid_syntax>true|false</valid_syntax>
  <score>0-10</score>
  <missing>comma-separated nodes/edges implied by the context but absent from the Mermaid, or "none"</missing>
  <hallucinated>comma-separated nodes in the Mermaid not supported by the context, or "none"</hallucinated>
  <improved_mermaid>
A corrected/improved full Mermaid diagram (keep what is right, fix the rest). If the candidate is already good, repeat it.
  </improved_mermaid>
</review>"""


def _fmt(prompt: str, **kw) -> str:
    return prompt.format(**kw)


# =============================================================================
# MODEL STEPS
# =============================================================================


async def _vision_call(prompt: str, crop_bytes: bytes, model: str, run_id: Optional[str]) -> str:
    return await call_model(
        model=model,
        messages=vision_message(prompt, crop_bytes),
        temperature=0.0,
        max_tokens=1024,
        workspace_id="default",
        role="vision",
        run_id=run_id,
    )


async def _text_call(prompt: str, model: str, run_id: Optional[str]) -> str:
    return await call_model(
        model=model,
        messages=[{"role": "user", "content": prompt}],
        temperature=0.0,
        max_tokens=1024,
        workspace_id="default",
        role="graph_synthesis",
        run_id=run_id,
    )


def _parse_review(raw: str) -> Dict[str, Any]:
    def field(tag):
        m = re.search(rf"<{tag}>(.*?)</{tag}>", raw, re.DOTALL | re.IGNORECASE)
        return m.group(1).strip() if m else ""
    score_s = field("score")
    try:
        score = float(re.search(r"[\d.]+", score_s).group())
    except Exception:
        score = 0.0
    return {
        "valid_syntax": field("valid_syntax").lower().startswith("t"),
        "score": score,
        "missing": field("missing"),
        "hallucinated": field("hallucinated"),
        "improved_mermaid": extract_code(field("improved_mermaid")),
    }


# =============================================================================
# ORCHESTRATION
# =============================================================================


async def describe_element(
    crop_bytes: bytes,
    *,
    label: str = "picture",
    caption: str = "",
    context: str = "",
    vlm_model: str = DEFAULT_VLM,
    reviewer_model: str = DEFAULT_REVIEWER,
    max_refine: int = 1,
    render_check: bool = False,
    run_id: Optional[str] = None,
    log_fn: Callable = print,
) -> Dict[str, Any]:
    """Run the full describe→validate→review→refine ladder for one visual element.

    Returns a surrogate dict: {type, surrogate_kind, content, validated, score,
    attempts:[...], review:{...}, model_id}. Never raises on a bad generation —
    degrades to a caption with validated=False.
    """
    ctx = (caption + "\n" + context).strip() or "(no surrounding text available)"
    kind = classify_visual(label, caption)
    attempts: List[Dict[str, Any]] = []

    if kind == "illustration":
        desc = await _vision_call(_fmt(ILLUSTRATION_PROMPT, context=ctx), crop_bytes, vlm_model, run_id)
        return {"type": label, "surrogate_kind": "caption", "content": desc.strip(),
                "validated": bool(desc.strip()), "score": None, "attempts": [], "model_id": vlm_model}

    if kind == "chart":
        raw = await _vision_call(_fmt(CHART_PROMPT, context=ctx), crop_bytes, vlm_model, run_id)
        js = extract_code(raw, "json")
        ok = js.strip().startswith("{") and js.strip().endswith("}")
        return {"type": label, "surrogate_kind": "chart_json" if ok else "caption",
                "content": js if ok else raw.strip(), "validated": ok, "score": None,
                "attempts": [], "model_id": vlm_model}

    # --- diagram: the multi-model loop ---
    # The VISION model always OWNS the topology (it can see the image). The text
    # reviewer is blind, so it only GUIDES — scores, flags missing/hallucinated/
    # syntax — which we feed back as a refinement critique. A reviewer-proposed
    # diagram is kept ONLY as a last resort if no vision attempt ever validates.
    best: Optional[Dict[str, Any]] = None
    reviewer_fallback: Optional[Dict[str, Any]] = None
    review: Dict[str, Any] = {}
    prompt = _fmt(DIAGRAM_PROMPT, context=ctx)

    for i in range(max_refine + 1):
        raw = await _vision_call(prompt, crop_bytes, vlm_model, run_id)
        mermaid = extract_code(raw, "mermaid")
        ok, reason = validate_mermaid(mermaid)
        # Optional authoritative gate: only count as valid if mmdc actually renders
        # it (catches everything the structural check can't). Skipped silently when
        # the renderer isn't installed.
        if ok and render_check:
            rok, rreason, _png = render_validate_mermaid(mermaid)
            if rreason != "mmdc-unavailable":
                ok, reason = rok, (reason if rok else rreason)
        attempts.append({"iter": i, "valid": ok, "reason": reason, "chars": len(mermaid)})
        log_fn(f"[describe] diagram attempt {i}: valid={ok} ({reason}) {len(mermaid)} chars")

        # review with the text model (cross-check vs document text)
        review_raw = await _text_call(_fmt(REVIEW_PROMPT, context=ctx, mermaid=mermaid), reviewer_model, run_id)
        review = _parse_review(review_raw)
        log_fn(f"[review] score={review['score']} valid_syntax={review['valid_syntax']} "
               f"missing={review['missing'][:60]!r}")

        cand = {"mermaid": mermaid, "valid": ok, "reason": reason,
                "score": review["score"], "review": review, "source": "vision"}
        if best is None or (ok and not best["valid"]) or (ok == best["valid"] and review["score"] > best["score"]):
            best = cand

        # capture a VALID reviewer-proposed diagram as fallback only (blind model)
        improved = review.get("improved_mermaid", "")
        if improved and reviewer_fallback is None and validate_mermaid(improved)[0]:
            reviewer_fallback = {"mermaid": improved, "valid": True, "score": review["score"],
                                 "review": review, "source": "reviewer_fallback"}

        if best["valid"] and review["score"] >= 8:
            break  # vision attempt is valid and the reviewer is happy
        if i < max_refine:
            prompt = (_fmt(DIAGRAM_PROMPT, context=ctx) +
                      f"\n\nYour previous attempt scored {review['score']}/10. FIX these, keeping the layout you can see:\n"
                      f"- missing nodes/edges: {review.get('missing','')}\n"
                      f"- remove if not in image: {review.get('hallucinated','')}\n"
                      f"- syntax issue: {reason if not ok else 'none'}\n")

    chosen = best if (best and best["valid"]) else (reviewer_fallback or best)
    if chosen and chosen["valid"]:
        return {"type": label, "surrogate_kind": "mermaid", "content": chosen["mermaid"],
                "validated": True, "score": chosen["score"], "attempts": attempts,
                "review": chosen.get("review", review), "model_id": vlm_model,
                "source": chosen.get("source", "vision")}

    # fallback: plain caption (no hollow success)
    cap = await _vision_call(_fmt(ILLUSTRATION_PROMPT, context=ctx), crop_bytes, vlm_model, run_id)
    return {"type": label, "surrogate_kind": "caption_fallback", "content": cap.strip(),
            "validated": False, "score": best["score"] if best else 0.0,
            "attempts": attempts, "review": review, "model_id": vlm_model}
