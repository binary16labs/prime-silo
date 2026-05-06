"""SR-3 scanner: forbid plaintext secrets under $BENNY_HOME and in the repo.

Invariant (PBR-001 §8): *No plaintext secret under `<SSD_ROOT>`.* The gate
combines two signals:

1. **Known-prefix detection** — high-precision match for vendor tokens whose
   shape is published (Anthropic, OpenAI, AWS, GitHub, Slack, GCP).
2. **Entropy heuristic** — an assignment whose right-hand side is a long,
   high-entropy mixed-case alphanumeric blob looks like a credential even
   if the vendor shape is unknown.
"""
from __future__ import annotations

import argparse
import dataclasses
import math
import re
import sys
from pathlib import Path
from typing import Iterable, Sequence

# --- known-prefix signatures ------------------------------------------------
#
# Each entry: (kind, compiled-regex). The regex must match the *value*, not
# just the vendor word — a bare reference like "ANTHROPIC_API_KEY_REF=FOO" is
# not a leak.
_KNOWN_PREFIXES: list[tuple[str, re.Pattern[str]]] = [
    ("anthropic",   re.compile(r"sk-ant-api03-[A-Za-z0-9_\-]{90,}")),
    ("openai",      re.compile(r"\bsk-(?!ant-)[A-Za-z0-9_\-]{40,}")),
    ("aws_access",  re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
    ("github_fine", re.compile(r"\bgithub_pat_[A-Za-z0-9_]{70,}\b")),
    ("github_pat",  re.compile(r"\bghp_[A-Za-z0-9]{30,}\b")),
    ("slack_bot",   re.compile(r"\bxox[bpars]-[A-Za-z0-9\-]{20,}\b")),
    ("gcp",         re.compile(r"\bAIza[A-Za-z0-9_\-]{30,}\b")),
    ("nvidia_nim",  re.compile(r"\bnvapi-[A-Za-z0-9_\-]{20,}\b")),
]

# Assignment-context pattern for entropy fallback. Captures the RHS.
_ASSIGN = re.compile(
    r"""(?:                       # left-hand side: key-ish token
         [A-Za-z_][A-Za-z0-9_]{2,}
        )
        \s*[:=]\s*
        ["']?                     # optional quote
        (?P<value>[A-Za-z0-9+/=_\-]{32,})  # 32+ char b64-ish blob
        ["']?
    """,
    re.VERBOSE,
)

# Lines that clearly self-describe as examples / placeholders.
_EXAMPLE_MARKERS = re.compile(
    r"\b(example|placeholder|do[_\s-]?not[_\s-]?use|sample|dummy|fake|not-needed)\b",
    re.IGNORECASE,
)


@dataclasses.dataclass(frozen=True)
class Violation:
    path: Path
    line_no: int
    snippet: str
    kind: str


def _shannon_entropy(s: str) -> float:
    if not s:
        return 0.0
    from collections import Counter

    counts = Counter(s)
    n = len(s)
    return -sum((c / n) * math.log2(c / n) for c in counts.values())


def _looks_like_credential(value: str) -> bool:
    """Heuristic: long, mixed-case alnum string with high Shannon entropy."""
    if len(value) < 40:
        return False
    has_upper = any(c.isupper() for c in value)
    has_lower = any(c.islower() for c in value)
    has_digit = any(c.isdigit() for c in value)
    if not (has_upper and has_lower and has_digit):
        return False
    return _shannon_entropy(value) >= 4.0  # empirical threshold


def scan_text(text: str) -> list[Violation]:
    out: list[Violation] = []
    for i, line in enumerate(text.splitlines(), start=1):
        is_example_line = bool(_EXAMPLE_MARKERS.search(line))

        # 1) known-prefix hits — always fire unless the line self-marks as example.
        for kind, pat in _KNOWN_PREFIXES:
            if pat.search(line):
                if is_example_line:
                    continue
                out.append(
                    Violation(
                        path=Path("<string>"),
                        line_no=i,
                        snippet=line.strip()[:200],
                        kind=kind,
                    )
                )
                break  # one hit per line is enough

        # 2) entropy fallback — only in assignment context.
        m = _ASSIGN.search(line)
        if m and not is_example_line:
            value = m.group("value")
            # don't double-count if a known-prefix already flagged
            if not any(pat.search(value) for _, pat in _KNOWN_PREFIXES):
                if _looks_like_credential(value):
                    out.append(
                        Violation(
                            path=Path("<string>"),
                            line_no=i,
                            snippet=line.strip()[:200],
                            kind="high_entropy",
                        )
                    )
    return out


def scan_file(path: Path) -> list[Violation]:
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except (OSError, UnicodeDecodeError):
        return []
    return [dataclasses.replace(v, path=path) for v in scan_text(text)]


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
            rel = p.relative_to(root).as_posix()
            if any(_glob_match(rel, x) for x in exclude_globs):
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
) -> list[Violation]:
    out: list[Violation] = []
    for f in _iter_candidate_files(root, include_globs, exclude_globs):
        out.extend(scan_file(f))
    return out


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="benny-scan-secrets",
        description="SR-3 gate: refuse plaintext secrets in tracked artifacts.",
    )
    parser.add_argument("targets", nargs="+", help="Files or directories to scan.")
    parser.add_argument(
        "--exclude",
        action="append",
        default=[],
        help="Glob to exclude. Can be given multiple times.",
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
            violations.extend(scan_tree(p, exclude_globs=excludes))
        elif p.is_file():
            violations.extend(scan_file(p))

    if violations:
        print("SR-3 violations (possible plaintext secrets):", file=sys.stderr)
        for v in violations:
            print(f"  {v.path}:{v.line_no}: [{v.kind}] {v.snippet}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
