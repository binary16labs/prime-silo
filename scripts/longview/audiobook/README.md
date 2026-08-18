# The AI Vampire — Audiobook Workflow (Prime-Silo)

Deterministic pipeline that turns the LONGVIEW book (`THE-AI-VAMPIRE.md`) into a
single narrated audiobook **MP3**, synthesized **one paragraph at a time** via
**Voicebox** (local Kokoro TTS) and stitched back together in fixed order.

```
01_prepare.py               markdown  ->  clean per-PARAGRAPH text + manifest.json
02_synthesize_paragraphs.py one Kokoro call per paragraph  ->  audio/chNN/pPPP.wav
03_stitch.py                paragraph WAVs  ->  one audiobook MP3 + chapter cue sheet
build/                      all generated artifacts live here
```

Assembly is pure Python stdlib (`wave`); only the final MP3 encode uses
`lameenc` (a pip wheel — **no ffmpeg**). Ordering is derived only from the source
section filenames (`p{part}c{chapter}s{section}.md`), so runs are reproducible.

## Why paragraph-at-a-time

- **Robust + resumable** at paragraph granularity: a failed or interrupted run
  re-does only the missing paragraphs, never a whole chapter.
- Voicebox never has to internally chunk-and-crossfade a 25k-char chapter, so
  prosody stays even and there are no mid-chapter seams.

## Source

- Book dir defaults to `../data_out/opus`; point it at any LONGVIEW book with
  `LONGVIEW_BOOK_DIR` (e.g. an `iterations/<name>` build).
- The pipeline reads the pre-split `sections/*.md` for clean text and the
  combined `THE-AI-VAMPIRE.md` only for the authoritative chapter/part titles.

## Prerequisites

```
pip install -r requirements.txt          # lameenc (MP3 encoder)
```

Voicebox running with its backend on `127.0.0.1:17493` and a **Kokoro** profile:

```
cd voicebox && backend/venv/Scripts/python -m backend.main --host 127.0.0.1 --port 17493
```

## How to run

### 1. Prepare

```
python 01_prepare.py
```

Writes `build/paras/chNN/pPPP.txt` (audiobook-clean: no `#`, no TOC, no
`(sid: …)` / `(concept: …)` / `[longview_card_…]` citations, no inline code or
LaTeX; each Part/Chapter announced by voice; sub-90-char fragments folded into
their neighbour) and `build/manifest.json` — the ordered chapter→paragraph list
that stages 2 and 3 both obey (`granularity: "paragraph"`).

### 2. Synthesize (Kokoro, one paragraph at a time)

```
python 02_synthesize_paragraphs.py                 # all pending paragraphs
python 02_synthesize_paragraphs.py --only-chapter 1
python 02_synthesize_paragraphs.py --limit 5       # smoke test
python 02_synthesize_paragraphs.py --status        # per-chapter done/total
python 02_synthesize_paragraphs.py --profile <id>  # override kokoro profile
```

Idempotent + resumable: a paragraph whose wav already exists is skipped.
Kokoro runs ≈ 0.25–0.35× real-time on CPU. `VOICEBOX_URL` and
`VOICEBOX_KOKORO_PROFILE` (default `Audiobook-Narrator`) are env-overridable.

### 3. Stitch into the audiobook MP3

```
python 03_stitch.py                         # -> build/THE-AI-VAMPIRE.mp3 (96 kbps)
python 03_stitch.py --bitrate 128
python 03_stitch.py --para-gap-ms 300 --chapter-gap-ms 1400
python 03_stitch.py --keep-wav              # also write the lossless WAV
python 03_stitch.py --allow-missing         # stitch only paragraphs present
```

Streams paragraphs → chapter (350 ms gap) → book (1200 ms gap) straight into the
LAME encoder, so memory stays flat even for a 6+ hour book. Writes
`build/THE-AI-VAMPIRE.mp3` and `build/chapters.cue.txt` (start timestamp per
chapter, for navigation / m4b metadata). All paragraph WAVs must share one format
(channels/width/rate) — they will, coming from one profile+engine; a mismatch is
reported instead of silently corrupting output.

## Determinism guarantees

- Chapter order = numeric sort of section filenames → identical every run.
- Fixed output names (`chNN/pPPP.txt`, `chNN/pPPP.wav`) → re-runs overwrite, never reorder.
- Stitch order = `manifest.json` order, not directory listing order.
- No timestamps or randomness enter the text or the assembly.

> The older whole-chapter driver (`02_run_kokoro.py`) and the MCP-path tracker
> (`02_synthesize.py`) are kept for reference, but the paragraph pipeline above is
> the intended path.
