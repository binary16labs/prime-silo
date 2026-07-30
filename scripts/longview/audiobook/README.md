# The AI Vampire — Audiobook Workflow (Prime-Silo)

Deterministic pipeline that turns `data_out/opus/THE-AI-VAMPIRE.md` into a single
narrated audiobook WAV, one chapter at a time, via **Voicebox** (local TTS,
`voicebox.sh`) and stitches the chapters back together in fixed order.

```
01_prepare.py     markdown  ->  clean, '#'-free per-chapter text + manifest.json
02_synthesize.py  driver/tracker for the Voicebox MCP step (the TTS itself)
03_stitch.py      per-chapter WAVs  ->  one audiobook WAV + chapter cue sheet
build/            all generated artifacts live here
```

Everything except the actual speech synthesis is pure Python stdlib — no ffmpeg,
no third-party packages. Ordering is derived only from the source section
filenames (`p{part}c{chapter}s{section}.md`), so runs are reproducible.

## Source

- Book: `../data_out/opus/THE-AI-VAMPIRE.md` (14 chapters, 4 parts, 72 sections)
- The pipeline reads the pre-split `../data_out/opus/sections/*.md` for clean text
  and the combined `.md` only for the authoritative chapter/part titles.

## Voicebox facts (discovered from `%APPDATA%/sh.voicebox.app/voicebox.db`)

- Profile to narrate with: **`Test`** — a _cloned_ voice (`voice_type=cloned`),
  engine `qwen`, model `1.7B`. Change with `--profile` if you make a new voice.
- `generation_settings`: `max_chunk_chars=800`, `crossfade_ms=50`,
  `normalize_audio=on`. Voicebox chunks long input internally and cross-fades the
  chunks, so passing a whole ~15k-char chapter in one call is fine.
- Voicebox is a **GUI + MCP-server** app — there is no CLI. Automation happens
  through its MCP `generate`/`speak` tool, called from a session where the
  Voicebox MCP is connected (see step 2).

## How to run

### 1. Prepare (done — re-run anytime the source changes)

```
python 01_prepare.py
```

Writes `build/chapters/ch01.txt … ch14.txt` (audiobook-clean: no `#`, no TOC, no
`(sid: …)` / `(concept: …)` / `[longview_card_…]` citations, no inline code or
LaTeX gibberish; each chapter and part is announced by voice) and
`build/manifest.json` (the ordered chapter list that stages 2 and 3 both obey).

### 2. Synthesize with Voicebox (one chapter at a time)

Make sure Voicebox is running with its **MCP server enabled** and connected to
the session doing this step. Then, for each chapter **in manifest order**:

1. `read build/chapters/chNN.txt`
2. call the Voicebox MCP generate tool: `text = <that file>`, `profile = "Test"`
3. save the returned audio to `build/audio/chNN.wav` (same NN)

Track progress at any time (idempotent — only missing chapters remain):

```
python 02_synthesize.py --status     # OK / -- per chapter, with durations
python 02_synthesize.py --plan       # ordered work list of what's still pending
python 02_synthesize.py --json       # same, machine-readable (text_file -> audio_out)
```

> If the Voicebox MCP ever rejects a chapter as too long, the section files
> (`../data_out/opus/sections/`) let you drop to section-level granularity and
> concatenate sections into `chNN.wav` first — but chapter-level is the intended
> path and Voicebox's internal chunking handles full chapters.

### 3. Stitch into the audiobook

```
python 03_stitch.py                  # 1.2 s gap between chapters (default)
python 03_stitch.py --silence-ms 800
python 03_stitch.py --allow-missing  # preview with only the chapters done so far
```

Writes `build/THE-AI-VAMPIRE.wav` (chapters concatenated in manifest order with
silence gaps) and `build/chapters.cue.txt` (start timestamp per chapter). All
chapter WAVs must share one format (channels/width/rate) — they will, coming from
one profile+engine; a mismatch is reported instead of silently corrupting output.

### Optional: WAV → MP3 / M4B

The deliverable is a WAV so the pipeline stays dependency-free. To compress or
make a chaptered `.m4b`, install ffmpeg and, e.g.:

```
ffmpeg -i build/THE-AI-VAMPIRE.wav -b:a 128k build/THE-AI-VAMPIRE.mp3
```

(The cue sheet has the chapter offsets for building m4b chapter metadata.)

## Determinism guarantees

- Chapter order = numeric sort of section filenames → identical every run.
- Fixed output names (`chNN.txt`, `chNN.wav`) → re-runs overwrite, never reorder.
- Stitch order = `manifest.json` order, not directory listing order.
- No timestamps or randomness enter the text or the assembly.
