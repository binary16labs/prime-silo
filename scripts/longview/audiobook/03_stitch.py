#!/usr/bin/env python3
"""
03_stitch.py  --  Prime-Silo audiobook pipeline, stage 3.

Deterministically concatenates the per-chapter WAV files that Voicebox produced
(stage 2) into a single audiobook WAV, in the exact order fixed by manifest.json.
Inserts a configurable gap of silence between chapters and emits a chapter cue
sheet (start timestamps) so the result is navigable.

Pure Python stdlib (`wave`) -- no ffmpeg / no third-party deps. It requires every
chapter WAV to share the same format (channels / sample width / sample rate),
which they will, since they all come from the same Voicebox profile+engine.

Run:  python 03_stitch.py                      # gap = 1.2 s between chapters
      python 03_stitch.py --silence-ms 800
      python 03_stitch.py --allow-missing       # stitch whatever is present

Output: build/THE-AI-VAMPIRE.wav , build/chapters.cue.txt
"""

from __future__ import annotations
import argparse
import json
import sys
import wave
from pathlib import Path

HERE = Path(__file__).resolve().parent
BUILD = HERE / "build"
MANIFEST = BUILD / "manifest.json"


def fmt_ts(seconds: float) -> str:
    ms = int(round(seconds * 1000))
    h, ms = divmod(ms, 3_600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d}.{ms:03d}"


def main() -> int:
    ap = argparse.ArgumentParser(description="Stitch chapter WAVs into one audiobook.")
    ap.add_argument("--silence-ms", type=int, default=1200,
                    help="silence inserted between chapters (default 1200)")
    ap.add_argument("--out", type=Path, default=None,
                    help="output wav path (default build/<book>.wav)")
    ap.add_argument("--allow-missing", action="store_true",
                    help="skip chapters whose wav is absent instead of failing")
    args = ap.parse_args()

    if not MANIFEST.is_file():
        print(f"ERROR: manifest not found: {MANIFEST}\nRun 01_prepare.py first.", file=sys.stderr)
        return 1

    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    chapters = manifest["chapters"]  # already in deterministic order
    book = manifest.get("book_title", "audiobook")
    out_path = args.out or (BUILD / f"{book.replace(' ', '-').upper()}.wav")

    # resolve + validate presence
    resolved: list[tuple[dict, Path]] = []
    missing: list[str] = []
    for ch in chapters:
        wav_path = (BUILD / ch["audio_file"]).resolve()
        if wav_path.is_file():
            resolved.append((ch, wav_path))
        else:
            missing.append(ch["audio_file"])

    if missing and not args.allow_missing:
        print("ERROR: missing chapter audio (run stage 2 / Voicebox first):", file=sys.stderr)
        for m in missing:
            print(f"  - {m}", file=sys.stderr)
        print("\nRe-run with --allow-missing to stitch only what exists.", file=sys.stderr)
        return 2
    if not resolved:
        print("ERROR: no chapter WAVs found to stitch.", file=sys.stderr)
        return 2

    # reference format from the first file; enforce consistency
    ref_params = None
    with wave.open(str(resolved[0][1]), "rb") as w:
        ref_params = (w.getnchannels(), w.getsampwidth(), w.getframerate())
    nch, sw, fr = ref_params
    silence_frames = int(fr * args.silence_ms / 1000)
    silence_bytes = b"\x00" * (silence_frames * nch * sw)

    cue: list[str] = []
    total_frames = 0

    out_path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(out_path), "wb") as out:
        out.setnchannels(nch)
        out.setsampwidth(sw)
        out.setframerate(fr)

        for idx, (ch, wav_path) in enumerate(resolved):
            with wave.open(str(wav_path), "rb") as w:
                params = (w.getnchannels(), w.getsampwidth(), w.getframerate())
                if params != ref_params:
                    print(f"ERROR: format mismatch in {wav_path.name}: {params} != {ref_params}\n"
                          f"       Re-export all chapters from Voicebox at identical settings, "
                          f"or resample with ffmpeg.", file=sys.stderr)
                    return 3
                start_s = total_frames / fr
                cue.append(f"{fmt_ts(start_s)}  Ch{ch['chapter']:>2}  {ch['title']}")
                frames = w.readframes(w.getnframes())
                out.writeframes(frames)
                total_frames += w.getnframes()

            if idx != len(resolved) - 1 and silence_frames:
                out.writeframes(silence_bytes)
                total_frames += silence_frames

    total_s = total_frames / fr
    cue_path = BUILD / "chapters.cue.txt"
    cue_header = f"# {book} -- chapter cue sheet ({len(resolved)} chapters, {fmt_ts(total_s)})\n"
    cue_path.write_text(cue_header + "\n".join(cue) + "\n", encoding="utf-8")

    print(f"Stitched {len(resolved)} chapters -> {out_path}")
    print(f"  format: {nch}ch / {sw*8}-bit / {fr} Hz   gap: {args.silence_ms} ms")
    print(f"  total duration: {fmt_ts(total_s)}")
    if missing:
        print(f"  WARNING: skipped {len(missing)} missing chapter(s): {', '.join(missing)}")
    print(f"  cue sheet: {cue_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
