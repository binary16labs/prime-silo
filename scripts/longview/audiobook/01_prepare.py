#!/usr/bin/env python3
"""
01_prepare.py  --  Prime-Silo audiobook pipeline, stage 1.

Turns THE-AI-VAMPIRE (markdown, split into per-section files) into clean,
narratable per-CHAPTER text plus a deterministic manifest.json that drives
the Voicebox TTS step (stage 2) and the stitcher (stage 3).

"Full audiobook clean":
  - no '#' / heading markers in the spoken text (headings become spoken lines)
  - the table-of-contents / part-divider pages are dropped
  - inline research citations  (concept: ...), (doc: ...), (longview_card_xxxx.md)
    and bare (something.md) parentheticals are removed
  - inline `code` / file-identifiers that read as gibberish are stripped, with
    the surrounding punctuation repaired
  - markdown emphasis / links / horizontal rules are flattened to plain prose
  - each chapter is announced ("Chapter 1. The Token Tax.") and each part is
    announced at its first chapter, so the audiobook is navigable by ear.

Deterministic: ordering comes purely from the section filenames
(p{part}c{chapter}s{section}.md) with a numeric sort -- no wall-clock, no rng.

Run:  python 01_prepare.py
Output: build/chapters/chNN.txt , build/manifest.json
"""

from __future__ import annotations
import json
import re
import os
import sys
from pathlib import Path

# ---------------------------------------------------------------- paths
# The pipeline runs from the LONGVIEW runtime workspace, where the book output
# lives at ../data_out/opus. When this canonical copy (in the prime-silo repo)
# is run from elsewhere, point it at the book with LONGVIEW_BOOK_DIR.
HERE = Path(__file__).resolve().parent
BOOK_DIR = Path(os.environ.get("LONGVIEW_BOOK_DIR", HERE.parent / "data_out" / "opus"))
SECTIONS_DIR = BOOK_DIR / "sections"
COMBINED_MD = BOOK_DIR / "THE-AI-VAMPIRE.md"

BUILD = HERE / "build"
CHAPTERS_OUT = BUILD / "chapters"
PARAS_OUT = BUILD / "paras"
MANIFEST_OUT = BUILD / "manifest.json"

BOOK_TITLE = "The AI Vampire"

# ---------------------------------------------------------------- cleaning

_SECNAME = re.compile(r"^p(\d+)c(\d+)s(\d+)$", re.IGNORECASE)

# citation / reference parentheticals that must never be spoken
_CITE_PATTERNS = [
    re.compile(r"\((?:concept|doc|see|ref|refs|source|sources|fig|figure|table|note|open thread|sid|session)\s*:[^)]*\)", re.IGNORECASE),
    re.compile(r"\([^)]*longview_card_[0-9a-f]+[^)]*\)", re.IGNORECASE),  # card refs (with/without .md)
    re.compile(r"\([^)]*\.md[^)]*\)", re.IGNORECASE),                     # bare file refs
    re.compile(r"\((?:[a-z_]+\s*:\s*)?[0-9a-f]{6,8}\)", re.IGNORECASE),   # (sid: hex) / bare hex ids
    # square-bracket variants: [longview_card_xxxx], [sid: hex], [ref.md]
    re.compile(r"\[[^\]]*longview_card_[0-9a-f]+[^\]]*\]", re.IGNORECASE),
    re.compile(r"\[[^\]]*\.md[^\]]*\]", re.IGNORECASE),
    re.compile(r"\[(?:[a-z_]+\s*:\s*)?[0-9a-f]{6,8}\]", re.IGNORECASE),
]

# inline LaTeX-ish math ($...$ / $$...$$) reads as gibberish -> drop it
_MATH = re.compile(r"\${1,2}[^$]*\${1,2}")

# bare filename tokens in prose (e.g. 6_SIGMA_PROGRESS_TRACKER.md, SKILL.md) that read
# as gibberish -> spoken as the de-underscored stem ("six sigma progress tracker")
_FILE_TOKEN = re.compile(r"\b([A-Za-z0-9][\w-]*)\.(?:md|py|json|txt|ya?ml|csv|ts|js|toml|cfg)\b")

# an inline-code token that is "code-like" (identifier / path / filename / assignment)
# -> should be dropped from narration rather than spelled out as gibberish
_CODEISH = re.compile(r"[_/=]|\.md\b|\.py\b|\.json\b|::|[A-Za-z]+[A-Z][A-Za-z]*")


def _file_token_repl(m: re.Match) -> str:
    stem = m.group(1)
    return stem.replace("_", " ").replace("-", " ")


def _strip_inline_code(text: str) -> str:
    """Remove `code` spans that look like identifiers/paths; keep plain-word spans."""
    def repl(m: re.Match) -> str:
        inner = m.group(1)
        # keep short, wordy spans (e.g. `orchestrator`) as plain words
        if not _CODEISH.search(inner) and len(inner.split()) <= 3:
            return inner
        return ""  # drop the gibberish token entirely; punctuation repaired later
    return re.sub(r"`([^`]*)`", repl, text)


def _repair_punctuation(text: str) -> str:
    text = re.sub(r"[ \t]+", " ", text)
    # a colon or comma left dangling before end-of-sentence -> just end it
    text = re.sub(r"\s*[:,]\s*\.", ".", text)
    text = re.sub(r"\s+([.,;:!?])", r"\1", text)     # space before punctuation
    text = re.sub(r"\.\s*\.(?:\s*\.)*", ".", text)   # collapsed empty spans -> single .
    text = re.sub(r"\(\s*\)", "", text)              # empty parens
    text = re.sub(r"\s{2,}", " ", text)
    text = re.sub(r"[ \t]+\n", "\n", text)
    return text.strip()


def clean_line(line: str) -> str:
    """Clean one line of markdown into narratable prose (may return '')."""
    s = line.rstrip()

    # horizontal rules -> gone
    if re.fullmatch(r"\s*-{3,}\s*", s):
        return ""

    # heading -> spoken line (drop the leading #'s), ensure it ends with a period
    m = re.match(r"^\s*#{1,6}\s+(.*)$", s)
    heading = False
    if m:
        s = m.group(1).strip()
        heading = True

    # markdown links [text](url) -> text
    s = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", s)

    # citation parentheticals
    for pat in _CITE_PATTERNS:
        s = pat.sub("", s)

    # inline math
    s = _MATH.sub("", s)

    # bare filename tokens -> readable stem
    s = _FILE_TOKEN.sub(_file_token_repl, s)

    # inline code
    s = _strip_inline_code(s)

    # any remaining stray/unmatched backticks
    s = s.replace("`", "")

    # emphasis markers  **bold** *italic* _italic_  -> plain
    s = re.sub(r"\*\*([^*]+)\*\*", r"\1", s)
    s = re.sub(r"\*([^*]+)\*", r"\1", s)
    s = re.sub(r"(?<!\w)_([^_]+)_(?!\w)", r"\1", s)
    s = s.replace("**", "").replace("*", "")

    s = _repair_punctuation(s)

    if heading and s and s[-1] not in ".!?:":
        s += "."
    return s


_FENCE = re.compile(r"```.*?```", re.DOTALL)

# A body paragraph shorter than this is folded into the previous one so the
# per-paragraph TTS never emits a one-clause fragment with a gap around it.
MIN_PARA_CHARS = 90


def clean_section_paras(md: str) -> list[str]:
    """Clean a whole section file into a list of narratable paragraphs."""
    md = _FENCE.sub("", md)  # drop fenced code blocks entirely
    out_paras: list[str] = []
    cur: list[str] = []
    for raw in md.splitlines():
        if raw.strip() == "":
            if cur:
                out_paras.append(" ".join(cur).strip())
                cur = []
            continue
        c = clean_line(raw)
        if c:
            cur.append(c)
    if cur:
        out_paras.append(" ".join(cur).strip())
    return [p for p in (_repair_punctuation(p) for p in out_paras) if p]


def clean_section(md: str) -> str:
    """Backward-compatible: the section's paragraphs joined for a chapter file."""
    return "\n\n".join(clean_section_paras(md))


def merge_short(paras: list[str], min_chars: int = MIN_PARA_CHARS) -> list[str]:
    """Fold too-short paragraphs into the previous one (keeps TTS units whole)."""
    merged: list[str] = []
    for p in paras:
        if merged and len(p) < min_chars:
            merged[-1] = (merged[-1].rstrip() + " " + p).strip()
        else:
            merged.append(p)
    # if the very first paragraph is itself tiny, pull the second up into it
    if len(merged) >= 2 and len(merged[0]) < min_chars:
        merged[0] = (merged[0].rstrip() + " " + merged[1]).strip()
        del merged[1]
    return merged


# ---------------------------------------------------------------- titles

def parse_titles(combined_md: str):
    """From the combined book: {chapterNum:int -> title}, {partNum:int -> (title, tagline)}."""
    chapters: dict[int, str] = {}
    parts: dict[int, tuple[str, str]] = {}
    lines = combined_md.splitlines()
    for i, line in enumerate(lines):
        mc = re.match(r"^##\s+Chapter\s+(\d+)\s*:\s*(.+)$", line.strip())
        if mc:
            chapters[int(mc.group(1))] = mc.group(2).strip()
            continue
        mp = re.match(r"^#\s+Part\s+(\d+)\s*:\s*(.+)$", line.strip())
        if mp:
            num = int(mp.group(1))
            title = mp.group(2).strip()
            tagline = ""
            # first italic line after the part heading
            for j in range(i + 1, min(i + 6, len(lines))):
                t = lines[j].strip()
                if t.startswith("*") and t.endswith("*") and len(t) > 2:
                    tagline = t.strip("*").strip()
                    break
                if t.startswith("#"):
                    break
            parts[num] = (title, tagline)
    return chapters, parts


# ---------------------------------------------------------------- build

def main() -> int:
    if not SECTIONS_DIR.is_dir():
        print(f"ERROR: sections dir not found: {SECTIONS_DIR}", file=sys.stderr)
        return 1

    chapter_titles, part_titles = parse_titles(
        COMBINED_MD.read_text(encoding="utf-8", errors="replace")
    )

    # group section files by chapter, deterministic numeric order
    sections: list[tuple[int, int, int, Path]] = []
    for p in SECTIONS_DIR.glob("*.md"):
        m = _SECNAME.match(p.stem)
        if not m:
            print(f"  skip (unrecognized name): {p.name}", file=sys.stderr)
            continue
        part, chap, sec = int(m.group(1)), int(m.group(2)), int(m.group(3))
        sections.append((part, chap, sec, p))
    sections.sort(key=lambda t: (t[1], t[2]))  # global chapter, then section

    chapters: dict[int, dict] = {}
    for part, chap, sec, path in sections:
        chapters.setdefault(chap, {"part": part, "sections": []})
        chapters[chap]["sections"].append((sec, path))

    CHAPTERS_OUT.mkdir(parents=True, exist_ok=True)

    manifest = {
        "book_title": BOOK_TITLE,
        "source": str(BOOK_DIR),
        "granularity": "paragraph",
        "chapter_count": len(chapters),
        "paragraph_count": 0,
        "chapters": [],
    }

    seen_parts: set[int] = set()
    total_paras = 0
    for order, chap in enumerate(sorted(chapters), start=1):
        info = chapters[chap]
        part = info["part"]
        ch_title = chapter_titles.get(chap, f"Chapter {chap}")

        # ---- build the ordered list of spoken PARAGRAPHS for this chapter ----
        # each entry: (kind, text). announcements are their own units; section
        # bodies are split into real paragraphs and short ones folded in.
        units: list[tuple[str, str]] = []

        if part not in seen_parts:
            seen_parts.add(part)
            p_title, p_tag = part_titles.get(part, (f"Part {part}", ""))
            units.append(("announce", f"Part {part}. {p_title}."))
            if p_tag:
                units.append(("announce", p_tag if p_tag.endswith((".", "!", "?")) else p_tag + "."))
        units.append(("announce", f"Chapter {chap}. {ch_title}."))

        body_paras: list[str] = []
        for _sec, path in sorted(info["sections"], key=lambda t: t[0]):
            body_paras.extend(clean_section_paras(path.read_text(encoding="utf-8", errors="replace")))
        for p in merge_short(body_paras):
            units.append(("body", p))

        # ---- write per-paragraph text files + the chapter reference file ----
        ch_dir = PARAS_OUT / f"ch{order:02d}"
        ch_dir.mkdir(parents=True, exist_ok=True)
        para_records: list[dict] = []
        for pidx, (kind, ptext) in enumerate(units, start=1):
            pid = f"ch{order:02d}_p{pidx:03d}"
            ptxt_rel = f"paras/ch{order:02d}/p{pidx:03d}.txt"
            (BUILD / ptxt_rel).write_text(ptext.strip() + "\n", encoding="utf-8")
            para_records.append({
                "id": pid,
                "kind": kind,
                "order": pidx,
                "text_file": ptxt_rel,
                "audio_file": f"audio/ch{order:02d}/p{pidx:03d}.wav",
                "chars": len(ptext),
            })
        total_paras += len(para_records)

        # chapter reference text (whole chapter, human-readable / debugging)
        fname = f"ch{order:02d}.txt"
        (CHAPTERS_OUT / fname).write_text(
            "\n\n".join(t for _k, t in units).strip() + "\n", encoding="utf-8")

        manifest["chapters"].append({
            "order": order,
            "chapter": chap,
            "part": part,
            "title": ch_title,
            "text_file": f"chapters/{fname}",
            "chapter_audio": f"audio/ch{order:02d}.wav",
            "chars": sum(p["chars"] for p in para_records),
            "sections": len(info["sections"]),
            "paragraphs": para_records,
            "status": "pending",
        })

    manifest["paragraph_count"] = total_paras
    MANIFEST_OUT.parent.mkdir(parents=True, exist_ok=True)
    MANIFEST_OUT.write_text(json.dumps(manifest, indent=2, ensure_ascii=False), encoding="utf-8")

    total = sum(c["chars"] for c in manifest["chapters"])
    print(f"Prepared {len(manifest['chapters'])} chapters / {total_paras} paragraphs -> {PARAS_OUT}")
    for c in manifest["chapters"]:
        print(f"  ch{c['order']:02d}  P{c['part']} Ch{c['chapter']:>2}  "
              f"{len(c['paragraphs']):>3} paras  {c['chars']:>6} chars  {c['title']}")
    print(f"Total narratable text: {total:,} chars  (~{total/900:.0f} min @ ~150 wpm)")
    print(f"Manifest: {MANIFEST_OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
