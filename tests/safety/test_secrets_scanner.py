"""SR-3 gate: no plaintext secrets under $BENNY_HOME (or in tracked repo).

Covers acceptance criterion AC-SR3-a from PBR-001.
Scanner under test: `benny.governance.portability.secrets_scanner`.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from benny.governance.portability import secrets_scanner as scanner


# Each tuple: (label, offending_line). Values are fake but match the known
# prefix shape enforced by the providers in question.
KNOWN_PREFIX_CASES = [
    ("anthropic",   "ANTHROPIC_API_KEY=sk-ant-api03-" + "A" * 95),
    ("openai",      "OPENAI_API_KEY=sk-" + "B" * 48),
    ("aws_access",  "AWS_ACCESS_KEY_ID=AKIA" + "C" * 16),
    ("github_pat",  "token: ghp_" + "D" * 36),
    ("github_fine", "token: github_pat_" + "E" * 82),
    ("slack_bot",   "SLACK_TOKEN=xoxb-" + "F" * 40),
    ("gcp",         "key: AIza" + "G" * 35),
]


@pytest.mark.parametrize("label,line", KNOWN_PREFIX_CASES, ids=[c[0] for c in KNOWN_PREFIX_CASES])
def test_blocks_known_prefix_secrets(label: str, line: str) -> None:
    hits = scanner.scan_text(line)
    assert hits, f"scanner missed {label} secret: {line!r}"
    assert hits[0].kind == label, f"mislabeled {label}: got kind={hits[0].kind}"


@pytest.mark.parametrize(
    "line",
    [
        "ANTHROPIC_API_KEY_REF=ANTHROPIC_API_KEY",  # a reference, not a value
        "api_key: not-needed",                       # Lemonade's literal placeholder
        "provider: ollama",
        "# example: sk-ant-api03-EXAMPLE_DO_NOT_USE",  # obvious example text
        "AKIA_EXAMPLE_NOT_A_KEY",                    # shorter than AKIA + 16 chars
    ],
)
def test_false_positives_are_silenced(line: str) -> None:
    hits = scanner.scan_text(line)
    assert not hits, f"false positive on: {line!r} -> {hits}"


def test_entropy_catches_unprefixed_high_entropy_blob(tmp_path: Path) -> None:
    """High-entropy base64-ish strings in assignment context are flagged."""
    # Deliberately high-entropy mixed-case alnum string, 64 chars.
    blob = "aZ9kQ2mP7vB4nX8rY6tW1cE3fG5hJ0lK2oQ4sU7xY9zA1bC3dE5fG7hJ9kL0mN2p"
    sample = tmp_path / "creds.env"
    sample.write_text(f"SECRET={blob}\n", encoding="utf-8")
    hits = scanner.scan_file(sample)
    assert hits, "entropy scanner missed a high-entropy assigned value"


def test_scan_tree_respects_exclude_globs(tmp_path: Path) -> None:
    (tmp_path / "ignored").mkdir()
    (tmp_path / "ignored" / "k.env").write_text(
        "OPENAI_API_KEY=sk-" + "X" * 48 + "\n", encoding="utf-8"
    )
    hits = scanner.scan_tree(tmp_path, exclude_globs=("ignored/**",))
    assert hits == [], "exclude_globs did not suppress ignored tree"


def test_cli_returns_nonzero_on_offending_file(tmp_path: Path) -> None:
    bad = tmp_path / "bad.env"
    bad.write_text("ANTHROPIC_API_KEY=sk-ant-api03-" + "A" * 95 + "\n", encoding="utf-8")
    rc = scanner.main([str(tmp_path)])
    assert rc != 0


def test_cli_returns_zero_on_clean_tree(tmp_path: Path) -> None:
    good = tmp_path / "ok.env"
    good.write_text("ANTHROPIC_API_KEY_REF=ANTHROPIC_API_KEY\n", encoding="utf-8")
    rc = scanner.main([str(tmp_path)])
    assert rc == 0
