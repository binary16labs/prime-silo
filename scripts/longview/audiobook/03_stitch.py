#!/usr/bin/env python3
"""
03_stitch.py  --  Prime-Silo audiobook pipeline, stage 3 (paragraph -> book, MP3).

Deterministically assembles the per-PARAGRAPH WAVs from stage 2 into the finished
audiobook. Order is fixed entirely by manifest.json:

    paragraphs --(short gap)--> chapter --(long gap)--> book --> THE-AI-VAMPIRE.mp3

Encoding is streamed paragraph-by-paragraph straight into the LAME MP3 encoder
(`lameenc`, pure pip wheel -- no ffmpeg), so memory stays flat even for a
6+ hour book. A chapter cue sheet (start timestamp per chapter) is emitted for
navigation / m4b chapter metadata. Optionally also keep the lossless WAV.

Every paragraph WAV must share one format (channels / width / rate) -- they will,
coming from one Kokoro profile+engine; a mismatch is reported, not silently
resampled.

Run:  python 03_stitch.py                       # -> build/THE-AI-VAMPIRE.mp3
      python 03_stitch.py --bitrate 128         # kbps (default 96)
      python 03_stitch.py --para-gap-ms 300 --chapter-gap-ms 1400
      python 03_stitch.py --keep-wav            # also write the lossless WAV
      python 03_stitch.py --allow-missing       # stitch only paragraphs present

Output: build/THE-AI-VAMPIRE.mp3 (+ optional .wav) , build/chapters.cue.txt
"""

from __future__ import annotations
import argparse
import json
import sys
import wave
from pathlib import Path

try:
    import lameenc
except ImportError:
    lameenc = None

HERE = Path(__file__).resolve().parent
BUILD = HERE / "build"
MANIFEST = BUILD / "manifest.json"


def fmt_ts(seconds: float) -> str:
    ms = int(round(seconds * 1000))
    h, ms = divmod(ms, 3_600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d}.{ms:03d}"


def read_wav(path: Path, ref: tuple | None):
    """Return (params, pcm_bytes, nframes); validate against ref format if given."""
    with wave.open(str(path), "rb") as w:
        params = (w.getnchannels(), w.getsampwidth(), w.getframerate())
        frames = w.getnframes()
        pcm = w.readframes(frames)
    if ref is not None and params != ref:
        raise ValueError(f"format mismatch in {path.name}: {params} != {ref}")
    return params, pcm, frames


def main() -> int:
    ap = argparse.ArgumentParser(description="Stitch paragraph WAVs into one audiobook MP3.")
    ap.add_argument("--para-gap-ms", type=int, default=350,
                    help="silence between paragraphs within a chapter (default 350)")
    ap.add_argument("--chapter-gap-ms", type=int, default=1200,
                    help="silence between chapters (default 1200)")
    ap.add_argument("--bitrate", type=int, default=96, help="MP3 bitrate kbps (default 96)")
    ap.add_argument("--out", type=Path, default=None, help="output path (default build/<BOOK>.mp3)")
    ap.add_argument("--keep-wav", action="store_true", help="also write the lossless WAV alongside the MP3")
    ap.add_argument("--wav-only", action="store_true", help="skip MP3, write only the WAV")
    ap.add_argument("--allow-missing", action="store_true",
                    help="skip paragraphs whose wav is absent instead of failing")
    args = ap.parse_args()

    if not MANIFEST.is_file():
        print(f"ERROR: manifest not found: {MANIFEST}\nRun 01_prepare.py first.", file=sys.stderr)
        return 1
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    if manifest.get("granularity") != "paragraph":
        print("ERROR: manifest is not paragraph-granular. Re-run 01_prepare.py.", file=sys.stderr)
        return 1

    book = manifest.get("book_title", "audiobook")
    stem = book.replace(" ", "-").upper()
    want_mp3 = not args.wav_only
    if want_mp3 and lameenc is None:
        print("ERROR: lameenc not installed (needed for MP3).  pip install lameenc\n"
              "       or run with --wav-only.", file=sys.stderr)
        return 1

    # ---- resolve every paragraph WAV in book order, validate presence/format ----
    ordered: list[tuple[dict, dict, Path]] = []   # (chapter, paragraph, wav_path)
    missing = 0
    for ch in manifest["chapters"]:
        for para in ch["paragraphs"]:
            wav = (BUILD / para["audio_file"]).resolve()
            if wav.is_file():
                ordered.append((ch, para, wav))
            else:
                missing += 1
    if missing and not args.allow_missing:
        print(f"ERROR: {missing} paragraph WAV(s) missing (run stage 2 first).\n"
              f"       Re-run with --allow-missing to stitch only what exists.", file=sys.stderr)
        return 2
    if not ordered:
        print("ERROR: no paragraph WAVs found to stitch.", file=sys.stderr)
        return 2

    # reference format from the first paragraph; silence buffers
    ref, _, _ = read_wav(ordered[0][2], None)
    nch, sw, fr = ref
    para_sil = b"\x00" * (int(fr * args.para_gap_ms / 1000) * nch * sw)
    chap_sil = b"\x00" * (int(fr * args.chapter_gap_ms / 1000) * nch * sw)
    bytes_per_frame = nch * sw

    out_path = args.out or (BUILD / (f"{stem}.wav" if args.wav_only else f"{stem}.mp3"))
    out_path.parent.mkdir(parents=True, exist_ok=True)

    # ---- set up streaming sinks (WAV writer and/or LAME encoder) ----
    wav_out = None
    wav_path = None
    if args.wav_only or args.keep_wav:
        wav_path = out_path if args.wav_only else out_path.with_suffix(".wav")
        wav_out = wave.open(str(wav_path), "wb")
        wav_out.setnchannels(nch); wav_out.setsampwidth(sw); wav_out.setframerate(fr)

    mp3_out = enc = None
    if want_mp3:
        enc = lameenc.Encoder()
        enc.set_bit_rate(args.bitrate)
        enc.set_in_sample_rate(fr)
        enc.set_channels(nch)
        enc.set_quality(2)  # 2 = high quality / reasonable speed
        mp3_out = open(out_path, "wb")

    def emit(pcm: bytes) -> None:
        if wav_out is not None:
            wav_out.writeframes(pcm)
        if enc is not None:
            data = enc.encode(pcm)
            if data:
                mp3_out.write(data)

    # ---- stream: paragraphs -> chapter (short gap) -> book (long gap) ----
    cue: list[str] = []
    total_frames = 0
    last_chapter_order = None
    cur_ch_frames = 0
    used = 0

    for ch, para, wav in ordered:
        if ch["order"] != last_chapter_order:
            if last_chapter_order is not None and args.chapter_gap_ms:
                emit(chap_sil)
                total_frames += len(chap_sil) // bytes_per_frame
            cue.append(f"{fmt_ts(total_frames / fr)}  Ch{ch['chapter']:>2}  {ch['title']}")
            last_chapter_order = ch["order"]
            cur_ch_frames = 0
        else:
            if args.para_gap_ms:
                emit(para_sil)
                total_frames += len(para_sil) // bytes_per_frame
                cur_ch_frames += len(para_sil) // bytes_per_frame

        try:
            _, pcm, nframes = read_wav(wav, ref)
        except ValueError as e:
            print(f"ERROR: {e}\n       Re-synthesize all paragraphs at identical settings "
                  f"(one Kokoro profile).", file=sys.stderr)
            if wav_out is not None:
                wav_out.close()
            if mp3_out is not None:
                mp3_out.close()
                out_path.unlink(missing_ok=True)
            return 3
        emit(pcm)
        total_frames += nframes
        cur_ch_frames += nframes
        used += 1

    if enc is not None:
        tail = enc.flush()
        if tail:
            mp3_out.write(tail)
        mp3_out.close()
    if wav_out is not None:
        wav_out.close()

    total_s = total_frames / fr
    cue_path = BUILD / "chapters.cue.txt"
    cue_path.write_text(
        f"# {book} -- chapter cue sheet ({len(manifest['chapters'])} chapters, {fmt_ts(total_s)})\n"
        + "\n".join(cue) + "\n", encoding="utf-8")

    print(f"Stitched {used} paragraphs across {len(manifest['chapters'])} chapters.")
    print(f"  format: {nch}ch / {sw*8}-bit / {fr} Hz   "
          f"para gap {args.para_gap_ms} ms / chapter gap {args.chapter_gap_ms} ms")
    print(f"  duration: {fmt_ts(total_s)}")
    if want_mp3:
        mb = out_path.stat().st_size / 1e6
        print(f"  MP3: {out_path}  ({args.bitrate} kbps, {mb:.1f} MB)")
    if wav_path is not None:
        gb = wav_path.stat().st_size / 1e9
        print(f"  WAV: {wav_path}  ({gb:.2f} GB)")
    if missing:
        print(f"  WARNING: skipped {missing} missing paragraph(s) (--allow-missing).")
    print(f"  cue sheet: {cue_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
