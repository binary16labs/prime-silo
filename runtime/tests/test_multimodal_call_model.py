"""
VIS-001 / ADR-003 Phase 1 — multimodal router tests.

Guards the load-bearing claim that an image survives all the way through
``call_model()`` and the local-executor short-circuit (models.py §5) instead of
being silently flattened to a string. OQ-1 confirmed qwen3vl-it-4b-FLM on
Lemonade reads images; these tests stop a regression from re-blinding the path.

Offline tests (no server, no LLM) run under the BENNY_OFFLINE gate. The live
round-trip skips automatically when Lemonade is not reachable.
"""
import asyncio
import socket

import pytest

from benny.core import models as M
from benny.core.local_executor import (
    BaseOpenAICompatibleExecutor,
    _as_text,
    _is_multimodal,
)
from benny.core.vision import to_data_uri, vision_message

# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #

def _band_png() -> bytes:
    """Unguessable BLUE/RED/YELLOW vertical-band PNG, stdlib only."""
    import struct
    import zlib

    W, H = 300, 120
    bands = [(0, 0, 255), (255, 0, 0), (255, 255, 0)]
    raw = bytearray()
    for y in range(H):
        raw.append(0)
        for x in range(W):
            raw.extend(bands[min(x * 3 // W, 2)])

    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(
            ">I", zlib.crc32(tag + data) & 0xFFFFFFFF
        )

    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", W, H, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
        + chunk(b"IEND", b"")
    )


def _lemonade_up(host="127.0.0.1", port=13305) -> bool:
    try:
        with socket.create_connection((host, port), timeout=1):
            return True
    except OSError:
        return False


# --------------------------------------------------------------------------- #
# 1. content helpers
# --------------------------------------------------------------------------- #

def test_vision_message_uses_object_form():
    """OQ-1 proved FLM wants image_url as an OBJECT {url: ...}, not a bare string."""
    msgs = vision_message("describe", b"\x89PNG fake")
    content = msgs[0]["content"]
    assert content[0] == {"type": "text", "text": "describe"}
    img = content[1]
    assert img["type"] == "image_url"
    assert isinstance(img["image_url"], dict) and img["image_url"]["url"].startswith("data:image/png;base64,")


def test_to_data_uri_passthrough_and_bytes():
    assert to_data_uri("https://x/y.png") == "https://x/y.png"  # already a URL
    assert to_data_uri(b"abc").startswith("data:image/png;base64,")


def test_as_text_flattens_multimodal_and_passes_strings():
    multimodal = [{"type": "text", "text": "hello"}, {"type": "image_url", "image_url": {"url": "data:..."}}]
    assert _as_text(multimodal) == "hello"            # image part contributes no text
    assert _as_text("plain") == "plain"
    assert _as_text(None) == ""


def test_is_multimodal_detection():
    assert _is_multimodal([{"type": "text", "text": "x"}, {"type": "image_url", "image_url": {}}]) is True
    assert _is_multimodal([{"type": "text", "text": "x"}]) is False
    assert _is_multimodal("string") is False


# --------------------------------------------------------------------------- #
# 1b. vision model resolves local-first (VIS-F7)
# --------------------------------------------------------------------------- #

def test_qwen3vl_registry_entry_is_local():
    """The `qwen3vl` registry key must resolve to a local Lemonade model so the
    offline guard permits it (VIS-F7)."""
    cfg = M.get_model_config("qwen3vl")
    assert cfg["provider"] == "lemonade"
    assert cfg["model"] == "qwen3vl-it-4b-FLM"
    assert M.is_local_model("qwen3vl") is True
    assert M.is_local_model("lemonade/qwen3vl-it-4b-FLM") is True


# --------------------------------------------------------------------------- #
# 2. executor branch keeps the image (VIS-F6, local path)
# --------------------------------------------------------------------------- #

def test_executor_forwards_image_without_dropping(monkeypatch):
    """The OpenAI-compatible executor must POST the list content verbatim — the
    image part must reach the wire, and token bookkeeping must not crash on a list."""
    captured = {}

    class _Resp:
        def raise_for_status(self):
            pass

        def json(self):
            return {"choices": [{"message": {"content": "blue, red, yellow"}}]}

    class _Client:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def post(self, url, headers=None, json=None):
            captured["payload"] = json
            return _Resp()

    monkeypatch.setattr("benny.core.local_executor.httpx.AsyncClient", _Client)

    ex = BaseOpenAICompatibleExecutor("qwen3vl-it-4b-FLM", "lemonade", "http://x/api/v1")
    content = vision_message("colours?", b"img-bytes")[0]["content"]
    out = asyncio.run(ex.generate(prompt=content, max_tokens=16))

    assert out == "blue, red, yellow"
    user_msg = captured["payload"]["messages"][-1]
    assert user_msg["role"] == "user"
    # the image part survived to the wire, untouched
    assert any(p.get("type") == "image_url" for p in user_msg["content"])


# --------------------------------------------------------------------------- #
# 3. router /no_think guard survives list content (VIS-F6, router path)
# --------------------------------------------------------------------------- #

def test_call_model_no_think_guard_preserves_image(monkeypatch):
    """When thinking suppression fires on a vision call, the /no_think directive
    must go onto the TEXT part and leave the image part intact — not crash on
    str + list."""
    seen = {}

    class _FakeExecutor:
        provider_name = "lemonade"

        async def generate(self, prompt=None, system=None, **kwargs):
            seen["prompt"] = prompt
            return "blue, red, yellow"

        def count_tokens(self, text):
            return 0

    monkeypatch.setattr(M, "resolve_executor", lambda s: _FakeExecutor())
    # should_suppress_thinking is imported function-locally inside call_model,
    # so patch it at its source module.
    monkeypatch.setattr("benny.core.model_profiles.should_suppress_thinking", lambda *a, **k: True)
    monkeypatch.setattr(
        "benny.governance.operating_manual.build_system_prompt_augmentation",
        lambda *a, **k: "",
    )

    messages = vision_message("colours left to right?", b"img-bytes")
    out = asyncio.run(
        M.call_model(model="lemonade/qwen3vl-it-4b-FLM", messages=messages,
                     workspace_id="default", role="vision")
    )
    assert out == "blue, red, yellow"
    parts = seen["prompt"]
    assert isinstance(parts, list)
    text_parts = [p for p in parts if p.get("type") == "text"]
    image_parts = [p for p in parts if p.get("type") == "image_url"]
    assert text_parts and text_parts[0]["text"].startswith("/no_think")
    assert image_parts, "image part was dropped by the /no_think guard"


# --------------------------------------------------------------------------- #
# 4. live round-trip (skips without a server) — VIS-F8
# --------------------------------------------------------------------------- #

@pytest.mark.skipif(not _lemonade_up(), reason="Lemonade not running on :13305")
def test_vision_roundtrip_live():
    out = asyncio.run(
        M.call_model(
            model="lemonade/qwen3vl-it-4b-FLM",
            messages=vision_message(
                "This image has three vertical colour bands. List the colours "
                "strictly from left to right, comma-separated, nothing else.",
                _band_png(),
            ),
            temperature=0.0,
            max_tokens=64,
            workspace_id="default",
            role="vision",
        )
    )
    low = (out or "").lower()
    assert all(c in low for c in ("blue", "red", "yellow")), f"model did not see image: {out!r}"
    assert low.find("blue") < low.find("red") < low.find("yellow"), f"wrong order: {out!r}"
