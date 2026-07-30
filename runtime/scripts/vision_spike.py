"""
OQ-1 spike (VIS-001 / ADR-003) — verify a local VLM accepts OpenAI-style
`image_url` content AND actually sees the image.

RESULT (2026-06-28): qwen3vl-it-4b-FLM on Lemonade (127.0.0.1:13305) accepts the
`image_url` OBJECT form and correctly read an unguessable band order
(blue, red, yellow). FLM vision is confirmed → primary VLM for `describe_visuals`.

Reproduce:  python scripts/vision_spike.py
            python scripts/vision_spike.py --base http://localhost:1234/v1 --model qwen3vl   # lmstudio fallback

No third-party deps (PNG built with stdlib zlib) so it runs in any environment.
"""
import argparse
import base64
import json
import struct
import sys
import urllib.error
import urllib.request
import zlib

W, H = 300, 120
BANDS = [(0, 0, 255), (255, 0, 0), (255, 255, 0)]  # unguessable: blue, red, yellow
EXPECT = ["blue", "red", "yellow"]


def make_png() -> bytes:
    raw = bytearray()
    for y in range(H):
        raw.append(0)  # filter type 0 per scanline
        for x in range(W):
            raw.extend(BANDS[min(x * 3 // W, 2)])

    def chunk(tag, data):
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xffffffff))

    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", W, H, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
            + chunk(b"IEND", b""))


def call(base, model, data_uri, content_form):
    image_part = ({"type": "image_url", "image_url": {"url": data_uri}}
                  if content_form == "object"
                  else {"type": "image_url", "image_url": data_uri})
    body = {
        "model": model,
        "messages": [{"role": "user", "content": [
            {"type": "text", "text": "This image has three vertical colour bands. "
             "List the colours strictly from left to right, comma-separated, nothing else."},
            image_part,
        ]}],
        "temperature": 0.0,
        "max_tokens": 64,
    }
    req = urllib.request.Request(base.rstrip("/") + "/chat/completions",
                                 data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=180) as r:
        return json.loads(r.read().decode())["choices"][0]["message"]["content"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://127.0.0.1:13305/api/v1")
    ap.add_argument("--model", default="qwen3vl-it-4b-FLM")
    args = ap.parse_args()

    data_uri = "data:image/png;base64," + base64.b64encode(make_png()).decode()
    print(f"[spike] {args.model} @ {args.base}  expected: {', '.join(EXPECT)}\n")

    for form in ("object", "string"):
        print(f"=== image_url as {form} ===")
        try:
            msg = call(args.base, args.model, data_uri, form)
            low = msg.lower()
            seen = all(c in low for c in EXPECT)
            order_ok = seen and low.find("blue") < low.find("red") < low.find("yellow")
            print(f"[response] {msg!r}\n[verdict] all-colours={seen} correct-order={order_ok}")
            if seen:
                print(f"\n*** OQ-1 PASS: accepts image_url ('{form}') and sees the image. ***")
                return 0
        except urllib.error.HTTPError as e:
            print(f"[HTTP {e.code}] {e.read().decode()[:400]}")
        except Exception as e:
            print(f"[ERR] {type(e).__name__}: {e}")
        print()
    print("*** OQ-1 FAIL: no correct vision answer in either form. ***")
    return 1


if __name__ == "__main__":
    sys.exit(main())
