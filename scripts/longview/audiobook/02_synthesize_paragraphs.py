#!/usr/bin/env python3
"""
02_synthesize_paragraphs.py  --  Prime-Silo audiobook pipeline, stage 2 (per-paragraph).

Synthesizes the book ONE PARAGRAPH AT A TIME with the fast Kokoro engine via the
running Voicebox backend (FastAPI on 127.0.0.1:17493), saving one WAV per
paragraph into build/audio/chNN/pPPP.wav. Fully idempotent + resumable at
paragraph granularity: a paragraph whose wav already exists is skipped, so a
failed or interrupted run only re-does the missing paragraphs -- never a whole
chapter. Stage 3 stitches the paragraphs back into chapters and the book.

Why per-paragraph (vs whole-chapter): robustness (one bad paragraph can't lose a
chapter), fine-grained resume, and even prosody -- Voicebox never has to
internally chunk-and-crossfade a 25k-char chapter.

Run:  python 02_synthesize_paragraphs.py                 # all pending paragraphs
      python 02_synthesize_paragraphs.py --only-chapter 1
      python 02_synthesize_paragraphs.py --limit 5        # first 5 pending (smoke test)
      python 02_synthesize_paragraphs.py --profile <id>   # override kokoro profile
      python 02_synthesize_paragraphs.py --status         # per-chapter done/total, no synth

Env: VOICEBOX_URL              (default http://127.0.0.1:17493)
     VOICEBOX_KOKORO_PROFILE   (kokoro profile id/name; default 'Audiobook-Narrator')
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
    profiles = json.load(urllib.request.urlopen(BASE + "/profiles", timeout=30))
    for p in profiles:
        if p["id"] == profile or p["name"] == profile:
            return p["id"]
    raise SystemExit(f"ERROR: kokoro profile '{profile}' not found. Create it in Voicebox or pass --profile.")


def flatten(manifest: dict, only_chapter: int | None):
    """Yield (chapter_dict, paragraph_dict) in book order."""
    for ch in manifest["chapters"]:
        if only_chapter is not None and ch["order"] != only_chapter:
            continue
        for para in ch["paragraphs"]:
            yield ch, para


def synth_paragraph(para: dict, profile_id: str) -> dict:
    text = (BUILD / para["text_file"]).read_text(encoding="utf-8").strip()
    dest = BUILD / para["audio_file"]
    dest.parent.mkdir(parents=True, exist_ok=True)
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
            raise RuntimeError(f"{para['id']} generation {st}: {s.get('error')}")
        time.sleep(0.5)
    size = _download(gid, dest)
    return {"duration": s.get("duration", 0.0), "bytes": size}


def print_status(manifest: dict) -> None:
    total_done = total = 0
    for ch in manifest["chapters"]:
        done = sum(1 for p in ch["paragraphs"] if (BUILD / p["audio_file"]).is_file())
        n = len(ch["paragraphs"])
        total_done += done
        total += n
        bar = "OK " if done == n else f"{done}/{n}"
        print(f"  ch{ch['order']:02d}  {bar:>7}  {ch['title']}")
    print(f"Paragraphs synthesized: {total_done}/{total}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only-chapter", type=int, default=None, help="only this chapter order number")
    ap.add_argument("--limit", type=int, default=None, help="synthesize at most N pending paragraphs (smoke test)")
    ap.add_argument("--profile", default=PROFILE, help="kokoro profile id or name")
    ap.add_argument("--force", action="store_true", help="regenerate even if the wav exists")
    ap.add_argument("--status", action="store_true", help="report per-chapter progress and exit")
    args = ap.parse_args()

    if not MANIFEST.is_file():
        raise SystemExit(f"ERROR: {MANIFEST} not found. Run 01_prepare.py first.")
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    if manifest.get("granularity") != "paragraph":
        raise SystemExit("ERROR: manifest is not paragraph-granular. Re-run 01_prepare.py.")

    if args.status:
        print_status(manifest)
        return 0

    try:
        urllib.request.urlopen(BASE + "/health", timeout=10)
    except Exception as e:
        raise SystemExit(
            f"ERROR: Voicebox backend not reachable at {BASE} ({e}).\n"
            f"Start it:  cd voicebox && backend/venv/Scripts/python -m uvicorn backend.main:app --port 17493")

    profile_id = resolve_profile_id(args.profile)

    work = [(ch, p) for ch, p in flatten(manifest, args.only_chapter)
            if args.force or not (BUILD / p["audio_file"]).is_file()]
    if args.limit is not None:
        work = work[:args.limit]

    total_units = sum(len(ch["paragraphs"]) for ch in manifest["chapters"]
                      if args.only_chapter is None or ch["order"] == args.only_chapter)
    print(f"Kokoro per-paragraph synthesis: profile={args.profile} ({profile_id[:8]})  "
          f"{len(work)} pending of {total_units}", flush=True)

    run_start = time.time()
    audio_secs = 0.0
    for i, (ch, para) in enumerate(work, start=1):
        t0 = time.time()
        try:
            res = synth_paragraph(para, profile_id)
        except Exception as e:
            print(f"  [{i}/{len(work)}] {para['id']} ERROR: {e}", flush=True)
            return 1
        audio_secs += res["duration"]
        print(f"  [{i}/{len(work)}] {para['id']}  {res['duration']:5.1f}s audio  "
              f"{time.time()-t0:4.1f}s wall  {res['bytes']//1024}KB", flush=True)

    done = sum(1 for ch in manifest["chapters"] for p in ch["paragraphs"]
               if (BUILD / p["audio_file"]).is_file())
    grand = sum(len(ch["paragraphs"]) for ch in manifest["chapters"])
    elapsed = (time.time() - run_start) / 60
    print(f"Done. {done}/{grand} paragraphs present. Synthesized {len(work)} in {elapsed:.1f} min "
          f"(~{audio_secs/60:.1f} min of audio).")
    if done == grand:
        print("All paragraphs ready -> run:  python 03_stitch.py")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
