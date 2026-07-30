#!/usr/bin/env python3
"""
02_synthesize.py  --  Prime-Silo audiobook pipeline, stage 2 (driver / tracker).

The actual text-to-speech is done by VOICEBOX via its MCP server -- that call is
issued by the agent/session that has the Voicebox MCP connected (this script has
no way to invoke it directly, Voicebox is a GUI+MCP app with no CLI). What this
script does is make that loop deterministic and resumable:

  --status   report which chapters are already synthesized vs pending
  --plan     print the exact ordered work list (chapter text -> target wav)
             that the agent should feed to the Voicebox MCP, one chapter at a time
  --json     machine-readable plan for the pending chapters

The contract the agent follows, per pending chapter (in manifest order):
  1. read  build/<text_file>            (already '#'-free, audiobook-clean prose)
  2. call the Voicebox MCP generate/speak tool with that text + the chosen profile
  3. save the returned audio as  build/<audio_file>   (audio/chNN.wav)
Then re-run `--status`; when all 14 are present, run 03_stitch.py.

Keeping one chapter per file + fixed names makes the whole thing idempotent:
re-running only regenerates what's missing.
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

# The Voicebox profile to narrate with (from voicebox.db). Override with --profile.
DEFAULT_PROFILE = "Test"


def wav_secs(p: Path):
    try:
        with wave.open(str(p), "rb") as w:
            return w.getnframes() / w.getframerate()
    except Exception:
        return None


def load():
    if not MANIFEST.is_file():
        print(f"ERROR: manifest not found: {MANIFEST}\nRun 01_prepare.py first.", file=sys.stderr)
        sys.exit(1)
    return json.loads(MANIFEST.read_text(encoding="utf-8"))


def refresh_status(manifest) -> None:
    """Sync each chapter's status field to whether its wav exists on disk."""
    for ch in manifest["chapters"]:
        exists = (BUILD / ch["audio_file"]).is_file()
        ch["status"] = "done" if exists else "pending"
    MANIFEST.write_text(json.dumps(manifest, indent=2, ensure_ascii=False), encoding="utf-8")


def main() -> int:
    ap = argparse.ArgumentParser(description="Voicebox synthesis driver/tracker.")
    ap.add_argument("--status", action="store_true", help="report done/pending chapters")
    ap.add_argument("--plan", action="store_true", help="print ordered work list for pending chapters")
    ap.add_argument("--json", action="store_true", help="emit pending plan as JSON")
    ap.add_argument("--profile", default=DEFAULT_PROFILE, help=f"Voicebox profile name (default {DEFAULT_PROFILE})")
    args = ap.parse_args()

    manifest = load()
    refresh_status(manifest)
    chapters = manifest["chapters"]
    pending = [c for c in chapters if c["status"] == "pending"]
    done = [c for c in chapters if c["status"] == "done"]

    if args.json:
        plan = [{
            "order": c["order"],
            "title": c["title"],
            "profile": args.profile,
            "text_file": str((BUILD / c["text_file"]).resolve()),
            "audio_out": str((BUILD / c["audio_file"]).resolve()),
            "chars": c["chars"],
        } for c in pending]
        print(json.dumps(plan, indent=2, ensure_ascii=False))
        return 0

    print(f"{manifest['book_title']}: {len(done)}/{len(chapters)} chapters synthesized "
          f"(profile: {args.profile})")
    for c in chapters:
        mark = "OK " if c["status"] == "done" else "-- "
        dur = ""
        if c["status"] == "done":
            s = wav_secs(BUILD / c["audio_file"])
            dur = f"  ({s/60:.1f} min)" if s else "  (unreadable wav!)"
        print(f"  [{mark}] ch{c['order']:02d}  {c['title']}{dur}")

    if args.plan or (not args.status and pending):
        print("\nNext (feed each to the Voicebox MCP, in this order, then save the wav):")
        for c in pending:
            print(f"  ch{c['order']:02d}  read {c['text_file']}  ->  save {c['audio_file']}  "
                  f"[{c['chars']} chars]")

    if not pending:
        print("\nAll chapters present -> run:  python 03_stitch.py")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
