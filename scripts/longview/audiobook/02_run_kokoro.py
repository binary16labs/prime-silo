#!/usr/bin/env python3
"""
02_run_kokoro.py  --  Prime-Silo audiobook pipeline, stage 2 (Kokoro driver).

Drives the running Voicebox backend (FastAPI on 127.0.0.1:17493) to synthesize
each chapter with the fast Kokoro engine (~0.35x real-time on CPU), saving one
WAV per chapter into build/audio/chNN.wav. Idempotent + resumable: chapters whose
wav already exists are skipped, so re-running only fills gaps.

Uses POST /generate (not /speak) because chapters exceed /speak's 10k-char cap;
/generate accepts up to 50k chars and chunks internally with crossfade.

Run:  python 02_run_kokoro.py                 # all pending chapters
      python 02_run_kokoro.py --only 1        # just chapter 1 (validation)
      python 02_run_kokoro.py --profile <id>  # override kokoro profile id

Env: VOICEBOX_URL (default http://127.0.0.1:17493)
     VOICEBOX_KOKORO_PROFILE  (kokoro preset profile id/name; default 'Narrator-Kokoro')
"""

from __future__ import annotations
import argparse
import json
import os
import time
import urllib.request
import urllib.error
from pathlib import Path

HERE = Path(__file__).resolve().parent
BUILD = HERE / "build"
MANIFEST = BUILD / "manifest.json"
AUDIO = BUILD / "audio"

BASE = os.environ.get("VOICEBOX_URL", "http://127.0.0.1:17493")
PROFILE = os.environ.get("VOICEBOX_KOKORO_PROFILE", "Audiobook-Narrator")
ENGINE = "kokoro"


def _post(path: str, obj: dict) -> dict:
    r = urllib.request.Request(BASE + path, data=json.dumps(obj).encode(),
                               headers={"Content-Type": "application/json"}, method="POST")
    return json.load(urllib.request.urlopen(r, timeout=600))


def _status(gid: str) -> dict:
    raw = urllib.request.urlopen(BASE + f"/generate/{gid}/status", timeout=60).read().decode()
    lines = [l for l in raw.splitlines() if l.startswith("data:")]
    return json.loads(lines[-1][5:]) if lines else json.loads(raw)


def _download(gid: str, dest: Path) -> int:
    with urllib.request.urlopen(BASE + f"/audio/{gid}", timeout=120) as resp:
        data = resp.read()
    dest.write_bytes(data)
    return len(data)


def resolve_profile_id(profile: str) -> str:
    """Accept a profile id or name; return the id."""
    profiles = json.load(urllib.request.urlopen(BASE + "/profiles", timeout=30))
    for p in profiles:
        if p["id"] == profile or p["name"] == profile:
            return p["id"]
    raise SystemExit(f"ERROR: kokoro profile '{profile}' not found. Create it or pass --profile.")


def synth_chapter(ch: dict, profile_id: str) -> None:
    text = (BUILD / ch["text_file"]).read_text(encoding="utf-8")
    dest = BUILD / ch["audio_file"]
    dest.parent.mkdir(parents=True, exist_ok=True)
    t0 = time.time()
    gid = _post("/generate", {
        "profile_id": profile_id,
        "text": text,
        "language": "en",
        "engine": ENGINE,
        "normalize": True,
    })["id"]
    while True:
        s = _status(gid)
        st = s["status"]
        if st == "completed":
            break
        if st in ("failed", "error", "cancelled"):
            raise RuntimeError(f"ch{ch['order']:02d} generation {st}: {s.get('error')}")
        time.sleep(2)
    size = _download(gid, dest)
    wall = time.time() - t0
    print(f"  ch{ch['order']:02d} OK  audio={s['duration']/60:.1f}min  wall={wall/60:.1f}min  "
          f"{size//1024}KB  {ch['title']}", flush=True)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", type=int, default=None, help="synthesize only this chapter order number")
    ap.add_argument("--profile", default=PROFILE, help="kokoro profile id or name")
    ap.add_argument("--force", action="store_true", help="regenerate even if wav exists")
    args = ap.parse_args()

    if not MANIFEST.is_file():
        raise SystemExit(f"ERROR: {MANIFEST} not found. Run 01_prepare.py first.")
    try:
        urllib.request.urlopen(BASE + "/health", timeout=10)
    except Exception as e:
        raise SystemExit(f"ERROR: Voicebox backend not reachable at {BASE} ({e}).\n"
                         f"Start it: cd voicebox && backend/venv/Scripts/python -m uvicorn backend.main:app --port 17493")

    profile_id = resolve_profile_id(args.profile)
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    chapters = manifest["chapters"]
    if args.only is not None:
        chapters = [c for c in chapters if c["order"] == args.only]

    todo = [c for c in chapters if args.force or not (BUILD / c["audio_file"]).is_file()]
    print(f"Kokoro synthesis: profile={args.profile} ({profile_id[:8]})  "
          f"{len(todo)}/{len(chapters)} to generate", flush=True)

    run_start = time.time()
    for c in todo:
        try:
            synth_chapter(c, profile_id)
        except Exception as e:
            print(f"  ch{c['order']:02d} ERROR: {e}", flush=True)
            return 1
    done = sum(1 for c in manifest["chapters"] if (BUILD / c["audio_file"]).is_file())
    print(f"Done. {done}/{len(manifest['chapters'])} chapters present. "
          f"Elapsed {(time.time()-run_start)/60:.1f} min.")
    if done == len(manifest["chapters"]):
        print("All chapters ready -> run:  python 03_stitch.py")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
