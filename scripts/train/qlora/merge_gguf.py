#!/usr/bin/env python3
"""T3 merge — LoRA adapter -> merged 16-bit -> quantized GGUF for serving (T4).

Dequantizes the 4-bit base to 16-bit, merges the trained LoRA, and exports a q4_k_m GGUF
via the ROCm llama.cpp checkout Unsloth installed (~/.unsloth/llama.cpp, llama-quantize.exe).
Then does a best-effort real-runtime load smoke with llama-server.exe (the target serving
runtime) and records it. Writes out/merge_manifest.json for the gate.

Run inside the Unsloth venv (vcvars64 shell — Triton, per T0):
    python scripts/train/qlora/merge_gguf.py
"""

import json
import os
import socket
import subprocess
import time
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = Path(os.environ.get("T3_QLORA_DIR", HERE / "out"))
ADAPTER_DIR = OUT / "adapter"
GGUF_DIR = OUT / "gguf"
QUANT = os.environ.get("T3_GGUF_QUANT", "q4_k_m")
LLAMA_CPP = Path(os.environ.get("LLAMA_CPP_DIR", Path.home() / ".unsloth" / "llama.cpp"))
LLAMA_SERVER = LLAMA_CPP / "build" / "bin" / "Release" / "llama-server.exe"


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def llama_server_load_smoke(gguf_path, timeout=180):
    """Load the GGUF in llama-server.exe (CPU, no offload) and hit /health. Best-effort:
    returns True on healthy load, False otherwise. Proves the file loads in the real runtime."""
    if not LLAMA_SERVER.exists():
        print(f"[merge] llama-server not found at {LLAMA_SERVER} — skipping runtime smoke")
        return None
    port = free_port()
    cmd = [str(LLAMA_SERVER), "--model", str(gguf_path), "--port", str(port),
           "-ngl", "0", "-c", "512", "--no-webui"]
    print(f"[merge] llama-server load smoke on :{port} (CPU) ...")
    proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        deadline = time.time() + timeout
        url = f"http://127.0.0.1:{port}/health"
        while time.time() < deadline:
            if proc.poll() is not None:
                print("[merge] llama-server exited before healthy")
                return False
            try:
                with urllib.request.urlopen(url, timeout=2) as r:
                    if r.status == 200:
                        print("[merge] llama-server /health OK — GGUF loads in target runtime")
                        return True
            except Exception:
                time.sleep(2)
        print("[merge] llama-server load smoke timed out")
        return False
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()


def main() -> int:
    if not ADAPTER_DIR.exists():
        raise SystemExit(f"[merge] adapter not found at {ADAPTER_DIR} — run train_qlora.py first")
    GGUF_DIR.mkdir(parents=True, exist_ok=True)

    from unsloth import FastLanguageModel

    model, tokenizer = FastLanguageModel.from_pretrained(
        model_name=str(ADAPTER_DIR), max_seq_length=2048, load_in_4bit=True, dtype=None,
    )
    print(f"[merge] exporting GGUF ({QUANT}) via {LLAMA_CPP} ...")
    model.save_pretrained_gguf(str(GGUF_DIR), tokenizer, quantization_method=QUANT)

    ggufs = sorted(GGUF_DIR.glob("*.gguf"))
    if not ggufs:
        raise SystemExit(f"[merge] no .gguf produced in {GGUF_DIR}")
    # prefer the quantized artifact if multiple (f16 + quant) were written
    quant_hits = [g for g in ggufs if QUANT.replace("_", "").lower() in g.name.replace("_", "").lower()]
    gguf_path = quant_hits[0] if quant_hits else ggufs[-1]
    size_mb = round(gguf_path.stat().st_size / 1024**2, 1)
    print(f"[merge] GGUF: {gguf_path.name} ({size_mb} MB)")

    server_ok = llama_server_load_smoke(gguf_path)

    manifest = {
        "gguf": str(gguf_path),
        "quant": QUANT,
        "size_mb": size_mb,
        "adapter": str(ADAPTER_DIR),
        "llama_cpp": str(LLAMA_CPP),
        "llama_server_load": server_ok,
        "all_ggufs": [g.name for g in ggufs],
    }
    (OUT / "merge_manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(f"[merge] wrote {OUT / 'merge_manifest.json'} — llama_server_load={server_ok}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
