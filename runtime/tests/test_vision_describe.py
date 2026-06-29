"""
VIS-001 / ADR-003 Phase 2 — vision-describe pure-logic tests (offline, no models).

Covers the classifier, Mermaid extraction + structural validation (incl. the
dotted-id failure the TOGAF ADM eval exposed), and the reviewer XML parser. The
live multi-model loop is evaluated by scripts against real TOGAF diagrams.
"""
from benny.core import vision_describe as V


# --------------------------------------------------------------------------- #
# classification
# --------------------------------------------------------------------------- #

def test_classify_chart_diagram_illustration():
    assert V.classify_visual("chart", "") == "chart"
    assert V.classify_visual("picture", "Figure 3-1 Architecture Development Cycle") == "diagram"
    assert V.classify_visual("picture", "Revenue by quarter bar chart") == "chart"
    assert V.classify_visual("picture", "Figure 2 The metamodel framework") == "diagram"
    assert V.classify_visual("picture", "a photo of the team") == "illustration"


def test_classify_region_defaults_to_diagram():
    # A vector-drawing region with NO caption used to fall through to "illustration"
    # (the Databricks miss). It must now be treated as a diagram.
    assert V.classify_visual("picture", "", is_region=True) == "diagram"
    # ...unless the caption says chart
    assert V.classify_visual("picture", "throughput bar chart", is_region=True) == "chart"


# --------------------------------------------------------------------------- #
# code extraction
# --------------------------------------------------------------------------- #

def test_extract_code_strips_fences_and_think():
    raw = "<think>reasoning</think>\n```mermaid\nflowchart TD\n A-->B\n```"
    assert V.extract_code(raw, "mermaid") == "flowchart TD\n A-->B"
    assert V.extract_code("flowchart TD\n A-->B") == "flowchart TD\n A-->B"


# --------------------------------------------------------------------------- #
# mermaid validation
# --------------------------------------------------------------------------- #

def test_validate_is_permissive_for_renderer_accepted_forms():
    # Calibrated against mmdc: dotted ids and `--|x|-->` labels DO render, so the
    # structural pre-filter must NOT hard-reject them (those are quality, not
    # validity — handled by prompt + reviewer + the authoritative render gate).
    assert V.validate_mermaid("flowchart TD\n P --> A.[Vision]\n A.[Vision] --> B")[0] is True
    assert V.validate_mermaid("flowchart TD\n A[X] --|lbl|--> B[Y]")[0] is True


def test_validate_accepts_clean_cycle_with_hub():
    good = ("flowchart TD\n P[Preliminary] --> A\n A[Vision] --> B\n B[Biz] --> A\n"
            " RM[Requirements Management] <--> A\n RM <--> B")
    assert V.validate_mermaid(good) == (True, "ok")


def test_validate_rejects_missing_header_and_prose():
    assert not V.validate_mermaid("Preliminary then Architecture Vision then Business.")[0]
    ok, reason = V.validate_mermaid("flowchart TD\n This is a sentence describing the diagram.")
    assert not ok


def test_validate_rejects_unbalanced_subgraph():
    bad = "flowchart TD\n subgraph X\n A --> B"
    ok, reason = V.validate_mermaid(bad)
    assert not ok and "subgraph" in reason


def test_validate_rejects_no_edges():
    assert not V.validate_mermaid("flowchart TD\n A[Only a node]")[0]


def test_validate_accepts_correct_edge_label():
    good = "flowchart TD\n A[Artifacts] -->|Which are| B[Catalogs]\n B --> A"
    assert V.validate_mermaid(good) == (True, "ok")


def test_sanitize_strips_hash_comments():
    raw = "flowchart TD\n A --> B  # Note: a typo\n# full comment line\n B[Biz]"
    cleaned = V.extract_code(raw, "mermaid")
    assert "#" not in cleaned and "A --> B" in cleaned and "B[Biz]" in cleaned


# --------------------------------------------------------------------------- #
# reviewer XML parsing
# --------------------------------------------------------------------------- #

def test_parse_review_extracts_fields():
    raw = """<review>
      <valid_syntax>true</valid_syntax>
      <score>9</score>
      <missing>Architecture Repository</missing>
      <hallucinated>none</hallucinated>
      <improved_mermaid>```mermaid
flowchart TD
 A --> B
```</improved_mermaid>
    </review>"""
    r = V._parse_review(raw)
    assert r["valid_syntax"] is True
    assert r["score"] == 9.0
    assert r["missing"] == "Architecture Repository"
    assert r["improved_mermaid"] == "flowchart TD\n A --> B"


def test_parse_review_handles_garbage():
    r = V._parse_review("the model rambled with no xml")
    assert r["score"] == 0.0 and r["valid_syntax"] is False


# --------------------------------------------------------------------------- #
# table json -> markdown (for describer context)
# --------------------------------------------------------------------------- #

def test_table_json_to_markdown():
    md = V._table_json_to_markdown({"columns": ["a", "b"], "rows": [[1, None], ["x", "y"]]})
    assert "| a | b |" in md and "| 1 |  |" in md  # None -> blank cell


# --------------------------------------------------------------------------- #
# vision fidelity judge — XML parsing + degraded path
# --------------------------------------------------------------------------- #

def test_parse_judge_extracts_fields():
    raw = """<judge>
      <fidelity>8</fidelity>
      <missing>Bronze layer</missing>
      <wrong>arrow direction Silver->Gold</wrong>
      <extra>none</extra>
      <verdict>partial</verdict>
    </judge>"""
    j = V._parse_judge(raw)
    assert j["fidelity"] == 8.0
    assert j["missing"] == "Bronze layer"
    assert j["wrong"].startswith("arrow")
    assert j["verdict"] == "partial"


def test_parse_judge_handles_garbage():
    j = V._parse_judge("no xml here")
    assert j["fidelity"] == 0.0 and j["verdict"] == "unknown"


# --------------------------------------------------------------------------- #
# best-wins ordering keyed on visual fidelity
# --------------------------------------------------------------------------- #

def test_diagram_cand_better_prefers_valid_then_visual_then_review():
    valid_lo = {"valid": True, "score": 9.0, "visual_score": 5.0}
    invalid_hi = {"valid": False, "score": 10.0, "visual_score": 9.0}
    # valid beats invalid regardless of scores
    assert V._diagram_cand_better(valid_lo, invalid_hi) is True
    # among valid, higher visual fidelity wins (even with a lower reviewer score)
    valid_hi_visual = {"valid": True, "score": 6.0, "visual_score": 9.0}
    assert V._diagram_cand_better(valid_hi_visual, valid_lo) is True
    # a judged candidate beats an unjudged one (more evidence)
    unjudged = {"valid": True, "score": 9.5, "visual_score": None}
    assert V._diagram_cand_better(valid_lo, unjudged) is True
    # with neither judged, fall back to reviewer score
    a = {"valid": True, "score": 8.0, "visual_score": None}
    b = {"valid": True, "score": 7.0, "visual_score": None}
    assert V._diagram_cand_better(a, b) is True


# --------------------------------------------------------------------------- #
# full describe ladder with mocked models (the cascade, end to end, offline)
# --------------------------------------------------------------------------- #

def _msg_text(messages):
    c = messages[0]["content"]
    return c if isinstance(c, str) else c[0]["text"]


def test_describe_element_diagram_closes_on_visual_fidelity(monkeypatch):
    """Vision describes a diagram, blind reviewer scores it ok, and the VISION JUDGE
    confirms fidelity — surrogate is a validated Mermaid carrying the visual score."""
    import asyncio

    calls = {"describe": 0, "review": 0, "judge": 0}

    async def fake_call_model(model=None, messages=None, **kw):
        text = _msg_text(messages)
        if "converting a TECHNICAL DIAGRAM" in text:
            calls["describe"] += 1
            return "```mermaid\nflowchart TD\n A[Bronze]-->B[Silver]\n B-->C[Gold]\n```"
        if "meticulous reviewer" in text:
            calls["review"] += 1
            return ("<review><valid_syntax>true</valid_syntax><score>7</score>"
                    "<missing>none</missing><hallucinated>none</hallucinated>"
                    "<improved_mermaid></improved_mermaid></review>")
        if "FAITHFULLY reproduces" in text:
            calls["judge"] += 1
            return ("<judge><fidelity>9</fidelity><missing>none</missing><wrong>none</wrong>"
                    "<extra>none</extra><verdict>faithful</verdict></judge>")
        return ""

    # Force the no-renderer (text-mode) judge path so the test needs no mmdc/node.
    monkeypatch.setattr(V, "call_model", fake_call_model)
    monkeypatch.setattr(V, "render_validate_mermaid", lambda *a, **k: (False, "mmdc-unavailable", None))

    sur = asyncio.run(V.describe_element(
        b"cropbytes", label="picture", caption="Medallion architecture",
        is_region=True, page_bytes=b"pagebytes", max_refine=1, min_fidelity=7.0,
        log_fn=lambda *a: None,
    ))
    assert sur["surrogate_kind"] == "mermaid"
    assert sur["validated"] is True
    assert sur["visual_score"] == 9.0 and sur["verdict"] == "faithful"
    assert "Bronze" in sur["content"]
    # high fidelity on the first pass → no refine iteration
    assert calls["describe"] == 1 and calls["judge"] == 1


def test_describe_element_refines_on_low_fidelity_then_keeps_best(monkeypatch):
    """First diagram scores low on visual fidelity → the loop refines with the visual
    critique; the second, higher-fidelity diagram wins (best-wins by visual score)."""
    import asyncio

    state = {"describe": 0}

    async def fake_call_model(model=None, messages=None, **kw):
        text = _msg_text(messages)
        if "converting a TECHNICAL DIAGRAM" in text:
            state["describe"] += 1
            if state["describe"] == 1:
                return "```mermaid\nflowchart TD\n A[X]-->B[Y]\n```"
            return "```mermaid\nflowchart TD\n A[X]-->B[Y]\n B-->C[Z]\n```"
        if "meticulous reviewer" in text:
            return ("<review><valid_syntax>true</valid_syntax><score>6</score>"
                    "<missing>none</missing><hallucinated>none</hallucinated>"
                    "<improved_mermaid></improved_mermaid></review>")
        if "FAITHFULLY reproduces" in text:
            # low fidelity first, high after the refine
            fid = 4 if state["describe"] == 1 else 9
            verdict = "poor" if fid < 7 else "faithful"
            return (f"<judge><fidelity>{fid}</fidelity><missing>Z</missing><wrong>none</wrong>"
                    f"<extra>none</extra><verdict>{verdict}</verdict></judge>")
        return ""

    monkeypatch.setattr(V, "call_model", fake_call_model)
    monkeypatch.setattr(V, "render_validate_mermaid", lambda *a, **k: (False, "mmdc-unavailable", None))

    sur = asyncio.run(V.describe_element(
        b"crop", label="picture", caption="Fig 1 pipeline", max_refine=1,
        min_fidelity=7.0, log_fn=lambda *a: None,
    ))
    assert state["describe"] == 2  # refined once
    assert sur["surrogate_kind"] == "mermaid"
    assert sur["visual_score"] == 9.0 and "Z" in sur["content"]  # best (refined) kept


def test_judge_visual_fidelity_degrades_without_model(monkeypatch):
    import asyncio

    async def boom(*a, **k):
        raise RuntimeError("VLM down")

    monkeypatch.setattr(V, "call_model", boom)
    out = asyncio.run(V.judge_visual_fidelity(b"crop", "flowchart TD\n A-->B", log_fn=lambda *a: None))
    assert out["available"] is False
