"""
Vision message helpers (VIS-001 / ADR-003).

Build OpenAI-style multimodal chat content for the `vision` role. OQ-1 confirmed
qwen3vl-it-4b-FLM on Lemonade accepts the `image_url` OBJECT form
(``{"type": "image_url", "image_url": {"url": <data-uri>}}``), so that is what we
emit. Calls flow through ``call_model()`` like any other model (ADR-001 / VIS-SEC3).
"""

from __future__ import annotations

import base64
from pathlib import Path
from typing import Any, Dict, List, Union

ImageSource = Union[str, bytes, Path]  # data-uri/url string, raw bytes, or a file path


def to_data_uri(image: ImageSource, mime: str = "image/png") -> str:
    """Return a `data:` URI for an image given raw bytes, a file path, or a
    string that is already a URL/data-URI (passed through untouched)."""
    if isinstance(image, str):
        return image  # already a URL or data: URI
    if isinstance(image, Path):
        data = image.read_bytes()
        ext = image.suffix.lower().lstrip(".")
        if ext in ("jpg", "jpeg"):
            mime = "image/jpeg"
        elif ext in ("png", "gif", "webp", "bmp"):
            mime = f"image/{'jpeg' if ext == 'jpg' else ext}"
    else:
        data = image
    return f"data:{mime};base64," + base64.b64encode(data).decode()


def vision_message(
    text: str, *images: ImageSource, mime: str = "image/png"
) -> List[Dict[str, Any]]:
    """Build a single-user-message list for ``call_model(messages=...)`` carrying
    text plus one or more images, in the FLM-confirmed object form."""
    content: List[Dict[str, Any]] = [{"type": "text", "text": text}]
    for img in images:
        content.append({"type": "image_url", "image_url": {"url": to_data_uri(img, mime)}})
    return [{"role": "user", "content": content}]
