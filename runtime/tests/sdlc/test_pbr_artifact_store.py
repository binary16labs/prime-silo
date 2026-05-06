"""Phase 1 acceptance tests: AOS-F5, AOS-F6, AOS-F7.

AOS-F5 — content-addressed put/get round-trip
AOS-F6 — auto-promote outputs above threshold; summary clamped to 200 chars
AOS-F7 — artifact:// URI substitution resolved before tool execution
"""
import json
import pytest
from pathlib import Path

from benny.core.artifact_store import (
    put,
    get,
    gc,
    path_for,
    maybe_promote,
    resolve_uri,
    MAX_SUMMARY_CHARS,
    DEFAULT_PBR_THRESHOLD_TOKENS,
)
from benny.sdlc.contracts import ArtifactRef


# ---------------------------------------------------------------------------
# AOS-F5: content-addressed put / get round-trip
# ---------------------------------------------------------------------------


def test_aos_f5_artifact_put_get_roundtrip(tmp_path):
    """put() stores data; get() retrieves byte-identical content."""
    payload = "Hello, AOS-001 artifact store!"
    ref = put(payload, workspace_path=tmp_path)

    assert ref.uri.startswith("artifact://")
    assert ref.sha256 is not None
    assert ref.byte_size == len(payload.encode())

    recovered = get(ref.uri, workspace_path=tmp_path)
    assert recovered.decode("utf-8") == payload


def test_aos_f5_content_addressed(tmp_path):
    """Two puts of identical data produce the same URI (content-addressed)."""
    payload = b"deterministic content"
    ref1 = put(payload, workspace_path=tmp_path)
    ref2 = put(payload, workspace_path=tmp_path)
    assert ref1.uri == ref2.uri
    assert ref1.sha256 == ref2.sha256


def test_aos_f5_different_payloads_different_uris(tmp_path):
    """Different data produces different URIs."""
    ref1 = put("alpha", workspace_path=tmp_path)
    ref2 = put("beta", workspace_path=tmp_path)
    assert ref1.uri != ref2.uri


def test_aos_f5_bytes_payload(tmp_path):
    """put() accepts raw bytes."""
    data = b"\x00\x01\x02\x03binary"
    ref = put(data, workspace_path=tmp_path)
    assert get(ref.uri, workspace_path=tmp_path) == data


def test_aos_f5_get_missing_raises(tmp_path):
    """get() with an unknown URI raises FileNotFoundError."""
    with pytest.raises(FileNotFoundError):
        get("artifact://" + "a" * 64, workspace_path=tmp_path)


def test_aos_f5_get_invalid_uri_raises(tmp_path):
    """get() with a non-artifact:// URI raises ValueError."""
    with pytest.raises(ValueError):
        get("https://example.com/data", workspace_path=tmp_path)


# ---------------------------------------------------------------------------
# AOS-F6: auto-promote above threshold + summary clamp
# ---------------------------------------------------------------------------


def test_aos_f6_auto_promote_above_threshold(tmp_path):
    """maybe_promote() stores and returns ArtifactRef dict when input exceeds threshold."""
    # 5000 chars ≈ 1250 tokens — well above default 1024 threshold
    large_text = "x" * 5000
    result = maybe_promote(large_text, workspace_path=tmp_path)
    assert isinstance(result, dict)
    assert result["uri"].startswith("artifact://")
    assert result["byte_size"] == len(large_text.encode())


def test_aos_f6_no_promote_below_threshold(tmp_path):
    """maybe_promote() returns the original string when below threshold."""
    small_text = "short output"
    result = maybe_promote(small_text, workspace_path=tmp_path)
    assert result == small_text


def test_aos_f6_summary_clamp_200(tmp_path):
    """Summary is clamped to MAX_SUMMARY_CHARS (200) characters."""
    long_text = "A" * 1000
    ref = put(long_text, workspace_path=tmp_path)
    assert ref.summary is not None
    assert len(ref.summary) <= MAX_SUMMARY_CHARS


def test_aos_f6_custom_threshold(tmp_path):
    """maybe_promote() respects a caller-supplied threshold."""
    text = "x" * 100  # 25 tokens
    # Very low threshold — should promote
    result = maybe_promote(text, workspace_path=tmp_path, threshold_tokens=10)
    assert isinstance(result, dict)
    # High threshold — should not promote
    result2 = maybe_promote(text, workspace_path=tmp_path, threshold_tokens=10000)
    assert result2 == text


# ---------------------------------------------------------------------------
# AOS-F7: URI substitution in tool call
# ---------------------------------------------------------------------------


def test_aos_f7_uri_substitution_in_tool_call(tmp_path):
    """resolve_uri() expands artifact:// URIs to their stored content."""
    original = "SELECT * FROM trades WHERE risk > 0.9"
    ref = put(original, workspace_path=tmp_path)

    # Simulate a tool call argument containing the URI
    resolved = resolve_uri(ref.uri, workspace_path=tmp_path)
    assert resolved == original


def test_aos_f7_non_uri_passthrough(tmp_path):
    """resolve_uri() passes through non-artifact strings unchanged."""
    plain = "just a normal string"
    assert resolve_uri(plain, workspace_path=tmp_path) == plain


def test_aos_f7_uri_in_nested_dict(tmp_path):
    """resolve_uris_in_args() expands artifact:// values in a tool-args dict."""
    from benny.core.artifact_store import resolve_uris_in_args

    payload = json.dumps({"rows": list(range(100))})
    ref = put(payload, workspace_path=tmp_path)

    tool_args = {"query": ref.uri, "limit": 50, "label": "plain text"}
    resolved = resolve_uris_in_args(tool_args, workspace_path=tmp_path)
    assert resolved["query"] == payload
    assert resolved["limit"] == 50        # non-string untouched
    assert resolved["label"] == "plain text"


# ---------------------------------------------------------------------------
# GC
# ---------------------------------------------------------------------------


def test_gc_removes_unreferenced(tmp_path):
    """gc() removes artifacts not in keep_shas."""
    ref1 = put("keep me", workspace_path=tmp_path)
    ref2 = put("delete me", workspace_path=tmp_path)

    sha_keep = ref1.sha256
    sha_delete = ref2.sha256

    removed = gc(tmp_path, keep_shas={sha_keep})
    assert removed == 1

    # keep_sha still retrievable
    assert get(ref1.uri, workspace_path=tmp_path).decode() == "keep me"
    # deleted sha gone
    with pytest.raises(FileNotFoundError):
        get(ref2.uri, workspace_path=tmp_path)
