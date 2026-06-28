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
