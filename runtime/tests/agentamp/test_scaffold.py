"""AAMP-F33 — scaffold_skin() tests.

Covers:
  test_aamp_f33_scaffold_creates_draft     — directory + key files are created
  test_aamp_f33_scaffold_deterministic     — calling twice produces identical manifest
  test_aamp_f33_signature_null_in_stub     — signature field is always null in the draft
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from benny.agentamp.scaffold import scaffold_skin


# ---------------------------------------------------------------------------
# AAMP-F33: scaffold creates expected structure
# ---------------------------------------------------------------------------


def test_aamp_f33_scaffold_creates_draft(tmp_path):
    """scaffold_skin() creates the expected directory tree."""
    root = scaffold_skin("my-test-skin", drafts_dir=tmp_path)

    assert root.is_dir()
    assert (root / "skin.manifest.json").exists()
    assert (root / "sprites").is_dir()
    assert (root / "shaders").is_dir()
    assert (root / "sounds").is_dir()
    assert (root / "shaders" / "post_glow.frag.glsl").exists()


# ---------------------------------------------------------------------------
# AAMP-F33: deterministic — calling twice produces identical manifest JSON
# ---------------------------------------------------------------------------


def test_aamp_f33_scaffold_deterministic(tmp_path):
    """Calling scaffold_skin twice with the same id produces identical manifest JSON."""
    root1 = scaffold_skin("det-skin", drafts_dir=tmp_path / "first")
    root2 = scaffold_skin("det-skin", drafts_dir=tmp_path / "second")

    manifest1 = json.loads((root1 / "skin.manifest.json").read_text(encoding="utf-8"))
    manifest2 = json.loads((root2 / "skin.manifest.json").read_text(encoding="utf-8"))

    assert manifest1 == manifest2


# ---------------------------------------------------------------------------
# AAMP-F33: signature field must be null in every generated stub
# ---------------------------------------------------------------------------


def test_aamp_f33_signature_null_in_stub(tmp_path):
    """The scaffolded manifest's 'signature' field is always null (GATE-AAMP-AUTOSIGN-1)."""
    root = scaffold_skin("sig-check-skin", drafts_dir=tmp_path)
    manifest_data = json.loads((root / "skin.manifest.json").read_text(encoding="utf-8"))

    assert manifest_data["signature"] is None, (
        "scaffold MUST emit 'signature': null — auto-signing is forbidden "
        "(GATE-AAMP-AUTOSIGN-1)"
    )


# ---------------------------------------------------------------------------
# Idempotency — second call to scaffold_skin doesn't error
# ---------------------------------------------------------------------------


def test_scaffold_idempotent(tmp_path):
    """scaffold_skin can be called multiple times on the same id without error."""
    root_a = scaffold_skin("idempotent-skin", drafts_dir=tmp_path)
    root_b = scaffold_skin("idempotent-skin", drafts_dir=tmp_path)
    assert root_a == root_b


# ---------------------------------------------------------------------------
# Invalid id is rejected
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("bad_id", [
    "",
    "has spaces",
    "with/slash",
    "with\\backslash",
    "../evil",
    "0startswithdigit-ok" * 5,  # > 64 chars
])
def test_scaffold_invalid_id_rejected(tmp_path, bad_id):
    """scaffold_skin raises ValueError for unsafe or empty skin_id."""
    with pytest.raises(ValueError):
        scaffold_skin(bad_id, drafts_dir=tmp_path)


# ---------------------------------------------------------------------------
# BENNY_HOME default (uses env var when drafts_dir is None)
# ---------------------------------------------------------------------------


def test_scaffold_uses_benny_home(tmp_path, monkeypatch):
    """When drafts_dir is None, scaffold_skin places the draft under $BENNY_HOME."""
    monkeypatch.setenv("BENNY_HOME", str(tmp_path))
    root = scaffold_skin("env-skin")
    expected = tmp_path / "agentamp" / "drafts" / "env-skin"
    assert root == expected.resolve()
