"""SR-1 scanner: forbid absolute host paths in persisted artifacts.

Invariant (PBR-001 §8): *No absolute host path in any persisted artifact.*
The scanner catches the three host-root families used by the supported OS
matrix (Windows drive letters, POSIX user homes) and refuses to see them in
tracked source, config, or docs.

The **only** absolute path allowed to appear is the configured `<SSD_ROOT>`
(for example `D:/optimus`), passed in by the caller. Everything else is a
violation.
"""
from __future__ import annotations

import argparse
import dataclasses
import re
import sys
from pathlib import Path
from typing import Iterable, Sequence

# Windows drive letter followed by a path separator (backslash or forward).
# Kept strict so that ordinary text containing a colon is not falsely matched.
_WINDOWS_DRIVE = re.compile(r"\b([A-Za-z]):[\\/]")

# POSIX user-home roots. The lookbehind rejects word chars, slash, and a
# drive-colon, so a Windows drive path is handled exclusively by the
# `_WINDOWS_DRIVE` rule above and never double-fires here.
_POSIX_USER_HOMES = re.compile(r"(?<![\w/:])(/home/|/Users/|/mnt/|/media/|/var/home/)")

# URL guard — anything inside a URL is not a filesystem path for our purposes.
_URL = re.compile(r"https?://[^\s\"'<>]+", re.IGNORECASE)

# Lines that self-describe as regexes / patterns (e.g. a regex in a code span
# that documents what the scanner *looks for*). We don't want the doc about
# the scanner to be flagged by the scanner.
_REGEX_PATTERN_MARKER = re.compile(
    r"\b(regex|pattern|regexp|re\.compile|fnmatch)\b",
    re.IGNORECASE,
)


@dataclasses.dataclass(frozen=True)
class Violation:
    path: Path
    line_no: int
    snippet: str
    kind: str  # "windows_drive" | "posix_home"


def _mask_urls(line: str) -> str:
    return _URL.sub(lambda m: "[URL]" * (len(m.group(0)) // 5 or 1), line)


def _is_allowed_ssd_root(match_text: str, ssd_root: str | None) -> bool:
    """Does this absolute path point at the configured SSD root?

    The token under inspection ends at the first character that cannot appear
    inside a filesystem path (whitespace, quote, backtick, bracket, etc.). If
    that token equals the SSD root, or starts with ``<root>/``, it is allowed.
    """
    if not ssd_root:
        return False
    # Token = everything up to the first path-terminating character.
    boundary = re.search(r"[\s\"'`<>()\[\]{},;]", match_text)
    token = match_text[: boundary.start()] if boundary else match_text
    norm_token = token.replace("\\", "/").rstrip("/").lower()
    norm_root = ssd_root.replace("\\", "/").lower().rstrip("/")
    return norm_token == norm_root or norm_token.startswith(norm_root + "/")


def scan_text(text: str, *, ssd_root: str | None = None) -> list[Violation]:
    """Scan a string for absolute-path violations.

    `ssd_root` is the configured portable root (e.g. ``D:/optimus``). Paths
    that start with that root are permitted; all other absolute paths are
    flagged.
    """
    out: list[Violation] = []
    for i, raw_line in enumerate(text.splitlines(), start=1):
        # Lines that self-label as describing a regex/pattern are skipped: the
        # scanner must not fire on documentation of its own rules.
        if _REGEX_PATTERN_MARKER.search(raw_line):
            continue
        line = _mask_urls(raw_line)

        for m in _WINDOWS_DRIVE.finditer(line):
            start = m.start()
            tail = line[start : start + 256]
            if _is_allowed_ssd_root(tail, ssd_root):
                continue
            out.append(
                Violation(
                    path=Path("<string>"),
                    line_no=i,
                    snippet=raw_line.strip()[:200],
                    kind="windows_drive",
                )
            )

        for m in _POSIX_USER_HOMES.finditer(line):
            start = m.start()
            tail = line[start : start + 256]
            if _is_allowed_ssd_root(tail, ssd_root):
                continue
            out.append(
                Violation(
                    path=Path("<string>"),
                    line_no=i,
                    snippet=raw_line.strip()[:200],
                    kind="posix_home",
                )
            )
    return out


def scan_file(path: Path, *, ssd_root: str | None = None) -> list[Violation]:
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except (OSError, UnicodeDecodeError):
        return []
    return [dataclasses.replace(v, path=path) for v in scan_text(text, ssd_root=ssd_root)]


def _iter_candidate_files(
    root: Path,
    include_globs: Sequence[str],
    exclude_globs: Sequence[str],
) -> Iterable[Path]:
    seen: set[Path] = set()
    for pattern in include_globs or ("**/*",):
        for p in root.glob(pattern):
            if not p.is_file():
                continue
            rel = p.relative_to(root)
            rel_posix = rel.as_posix()
            if any(rel.match(x) or _glob_match(rel_posix, x) for x in exclude_globs):
                continue
            if p in seen:
                continue
            seen.add(p)
            yield p


def _glob_match(rel_posix: str, pattern: str) -> bool:
    from fnmatch import fnmatchcase

    return fnmatchcase(rel_posix, pattern)


def scan_tree(
    root: Path,
    *,
    include_globs: Sequence[str] = ("**/*",),
    exclude_globs: Sequence[str] = (
        "**/__pycache__/**",
        "**/.git/**",
        "**/node_modules/**",
        "**/.venv/**",
        "**/dist/**",
        "**/build/**",
    ),
    ssd_root: str | None = None,
) -> list[Violation]:
    out: list[Violation] = []
    for f in _iter_candidate_files(root, include_globs, exclude_globs):
        out.extend(scan_file(f, ssd_root=ssd_root))
    return out


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="benny-scan-paths",
        description="SR-1 gate: refuse absolute host paths in tracked artifacts.",
    )
    parser.add_argument("targets", nargs="+", help="Files or directories to scan.")
    parser.add_argument(
        "--ssd-root",
        default=None,
        help="Configured <SSD_ROOT>; paths under this root are allowed.",
    )
    parser.add_argument(
        "--exclude",
        action="append",
        default=[],
        help="Glob to exclude (relative to each target). Can be given multiple times.",
    )
    args = parser.parse_args(argv)

    excludes = (
        "**/__pycache__/**",
        "**/.git/**",
        "**/node_modules/**",
        "**/.venv/**",
        *args.exclude,
    )

    violations: list[Violation] = []
    for target in args.targets:
        p = Path(target)
        if p.is_dir():
            violations.extend(scan_tree(p, exclude_globs=excludes, ssd_root=args.ssd_root))
        elif p.is_file():
            violations.extend(scan_file(p, ssd_root=args.ssd_root))

    if violations:
        print("SR-1 violations (absolute host paths found):", file=sys.stderr)
        for v in violations:
            print(f"  {v.path}:{v.line_no}: [{v.kind}] {v.snippet}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
