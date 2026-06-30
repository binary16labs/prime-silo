"""Finalize a generated report: guarantee every diagram renders, then make a PDF.

This is the safety net that makes the report-generation workflow produce a clean
document regardless of what the local model emitted. It encodes every failure we
hit by hand:

  * merged / unclosed ``` code fences  -> normalize_fences()
  * non-portable diagram engines (Mermaid experimental C4, PlantUML) -> dropped
    with a visible note (most viewers can't render them)
  * Mermaid syntax the model gets wrong -> autofix_mermaid() (quote reserved ER
    entity names like Class/Function; strip parentheses inside node labels) then
    VALIDATE each block with the real Mermaid CLI (mmdc). Any block that still
    fails is replaced with a note instead of shipping broken syntax.

Then to_pdf() renders each (now-valid) Mermaid block to SVG via mmdc, converts
the Markdown to HTML, and prints a PDF with headless Chrome.

Public entry point: finalize(md_path) -> dict report. Degrades gracefully if
mmdc / Chrome are unavailable (still normalizes fences + drops non-portable
blocks; skips validation/PDF with a clear status).
"""
from __future__ import annotations

import glob
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

ALLOWED_TYPES = (
    "flowchart", "graph", "sequenceDiagram", "classDiagram", "erDiagram",
    "stateDiagram", "stateDiagram-v2", "journey", "gantt", "pie", "mindmap",
)
# Non-portable: render in mmdc but fail in most Markdown viewers (GitHub, VS Code).
FORBIDDEN_FIRST = ("C4Context", "C4Container", "C4Component", "C4Dynamic", "C4Deployment")
# Mermaid erDiagram reserved words that cannot be bare entity names.
ER_RESERVED = {
    "Class", "Function", "Order", "Group", "Type", "Key", "Index", "Node",
    "Entity", "Date", "Time", "User", "Table",
}

_NPM_CACHE = str(Path(tempfile.gettempdir()) / "report_npmcache")
_WORKDIR = str(Path(tempfile.gettempdir()) / "report_diaglint")


def _run(cmd, **kw):
    return subprocess.run(cmd, capture_output=True, text=True, **kw)


def find_chrome():
    # Order matters: the Playwright Chromium build loads ICU from disk and works
    # when launched from a Python subprocess. The puppeteer build (used by mmdc)
    # expects ICU via an inherited fd and crashes with "Invalid file descriptor
    # to ICU data received" under Python — so it is tried last.
    pats = [
        str(Path(os.environ.get("LOCALAPPDATA", "")) / "ms-playwright/chromium-*/chrome-win64/chrome.exe"),
        str(Path.home() / ".cache/ms-playwright/chromium-*/chrome-linux/chrome"),
        "C:/Program Files/Google/Chrome/Application/chrome.exe",
        "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
        str(Path.home() / ".cache/puppeteer/chrome/*/chrome-win64/chrome.exe"),
        str(Path.home() / ".cache/puppeteer/chrome/*/chrome-linux64/chrome"),
    ]
    for p in pats:
        hits = sorted(glob.glob(p))
        if hits:
            return hits[-1]
    return None


# --------------------------------------------------------------------------- #
# Fence normalization
# --------------------------------------------------------------------------- #
def normalize_fences(text: str) -> str:
    """Repair merged (```a```b) and unclosed code fences. Only ```mermaid opens
    are recognised as openers here, matching how the reports are authored."""
    out, in_block = [], False
    for ln in text.splitlines():
        s = ln.strip()
        if s == "```mermaid":
            if in_block:
                out.append("```")
                out.append("")
            out.append(ln)
            in_block = True
        elif s == "```" and in_block:
            out.append(ln)
            in_block = False
        else:
            out.append(ln)
    if in_block:
        out.append("```")
    return "\n".join(out) + "\n"


# --------------------------------------------------------------------------- #
# Per-block fixes + validation
# --------------------------------------------------------------------------- #
def autofix_mermaid(code: str) -> str:
    lines = code.splitlines()
    if not lines:
        return code
    first = lines[0].strip()

    if first.startswith("erDiagram"):
        # Quote reserved entity names on both sides of a relationship line.
        def fix_er(m):
            left, rel, right, lbl = m.group(1), m.group(2), m.group(3), m.group(4)
            ql = f'"{left}"' if left in ER_RESERVED else left
            qr = f'"{right}"' if right in ER_RESERVED else right
            return f"{ql} {rel} {qr} : {lbl}"
        fixed = []
        rel_re = re.compile(r"^(\w+)\s+(\|\|--o\{|\}o--\|\||\|\|--\|\||\}o--o\{|[|}{o\-]+)\s+(\w+)\s*:\s*(.+)$")
        for ln in lines:
            m = rel_re.match(ln.strip())
            if m:
                fixed.append("    " + fix_er(m))
            else:
                fixed.append(ln)
        return "\n".join(fixed)

    if first.startswith(("flowchart", "graph")):
        # Strip parentheses INSIDE square-bracket node labels: [a (b)] -> [a - b].
        def strip_parens(m):
            inner = m.group(1).replace("(", " - ").replace(")", "")
            return "[" + inner + "]"
        return "\n".join(re.sub(r"\[([^\[\]]*)\]", strip_parens, ln) for ln in lines)

    return code


def _mmdc_ok(code: str, mmdc_env) -> tuple[bool, str]:
    """Validate one block with mmdc. Returns (ok, error_snippet)."""
    Path(_WORKDIR).mkdir(parents=True, exist_ok=True)
    src = Path(_WORKDIR) / "block.mmd"
    out = Path(_WORKDIR) / "block.svg"
    src.write_text(code, encoding="utf-8")
    if out.exists():
        out.unlink()
    r = _run(
        ["npx", "-y", "-p", "@mermaid-js/mermaid-cli", "mmdc", "-i", str(src), "-o", str(out)],
        env=mmdc_env, cwd=_WORKDIR, shell=(os.name == "nt"),
    )
    if out.exists():
        return True, ""
    err = (r.stderr or r.stdout or "").strip()
    snippet = next((l for l in err.splitlines() if "rror" in l or "got" in l), err[:120])
    return False, snippet


def _iter_fences(text):
    """Yield (start, end, lang, body) for each ``` fenced block."""
    for m in re.finditer(r"```(\w*)[ \t]*\n(.*?)\n```", text, re.DOTALL):
        yield m.start(), m.end(), m.group(1), m.group(2)


def clean_markdown(text: str, use_mmdc: bool = True) -> tuple[str, list]:
    """Normalize fences, then keep/fix/drop every fenced diagram block."""
    text = normalize_fences(text)
    mmdc_env = {**os.environ, "npm_config_cache": _NPM_CACHE}
    report = []
    # Process from the end so indices stay valid as we splice replacements.
    spans = list(_iter_fences(text))
    for start, end, lang, body in reversed(spans):
        replacement = None
        first = body.strip().splitlines()[0].strip() if body.strip() else ""
        if lang == "plantuml" or first.startswith("@startuml"):
            replacement = "> _[diagram omitted — PlantUML is not portable; regenerate as Mermaid]_"
            report.append(("drop-plantuml", first[:40]))
        elif lang == "mermaid" and first.startswith(FORBIDDEN_FIRST):
            replacement = f"> _[diagram omitted — Mermaid {first.split()[0]} is experimental and not widely supported]_"
            report.append(("drop-c4", first[:40]))
        elif lang == "mermaid":
            fixed = autofix_mermaid(body)
            ok, err = (_mmdc_ok(fixed, mmdc_env) if use_mmdc else (True, ""))
            if ok:
                if fixed != body:
                    report.append(("autofixed", first[:40]))
                replacement = "```mermaid\n" + fixed + "\n```"
            else:
                replacement = f"> _[diagram omitted — invalid Mermaid: {err[:80]}]_"
                report.append(("drop-invalid", f"{first[:30]} :: {err[:50]}"))
        if replacement is not None:
            text = text[:start] + replacement + text[end:]
    return text, list(reversed(report))


# --------------------------------------------------------------------------- #
# PDF
# --------------------------------------------------------------------------- #
_CSS = """
body{font-family:'Segoe UI',Arial,sans-serif;max-width:900px;margin:24px auto;
 padding:0 24px;color:#1a1a1a;line-height:1.5;font-size:13px}
h1,h2,h3{color:#0b3d5c;margin-top:1.4em}h1{border-bottom:2px solid #0b3d5c;padding-bottom:.2em}
code{background:#f3f3f3;padding:1px 4px;border-radius:3px;font-size:.92em}
pre{background:#f6f8fa;padding:10px;border-radius:6px;overflow:auto}
table{border-collapse:collapse;width:100%;margin:1em 0}th,td{border:1px solid #d0d0d0;padding:6px 8px;text-align:left}
th{background:#eef4f8}.diagram{text-align:center;margin:14px 0}.diagram svg{max-width:100%;height:auto}
blockquote{color:#777;border-left:3px solid #ccc;padding-left:10px}
"""


def to_pdf(md_path: Path, pdf_path: Path) -> tuple[bool, str]:
    try:
        import markdown as mdlib
    except Exception:
        return False, "python 'markdown' package not installed"
    chrome = find_chrome()
    if not chrome:
        return False, "no Chrome/Chromium found for PDF printing"

    text = md_path.read_text(encoding="utf-8")
    mmdc_env = {**os.environ, "npm_config_cache": _NPM_CACHE}
    Path(_WORKDIR).mkdir(parents=True, exist_ok=True)

    # Render each mermaid block to inline SVG and swap it into the markdown.
    def render(m):
        body = m.group(1)
        src = Path(_WORKDIR) / "d.mmd"
        out = Path(_WORKDIR) / "d.svg"
        src.write_text(body, encoding="utf-8")
        if out.exists():
            out.unlink()
        _run(["npx", "-y", "-p", "@mermaid-js/mermaid-cli", "mmdc", "-i", str(src),
              "-o", str(out), "-b", "white"], env=mmdc_env, cwd=_WORKDIR, shell=(os.name == "nt"))
        if out.exists():
            svg = out.read_text(encoding="utf-8")
            svg = re.sub(r"<\?xml.*?\?>", "", svg, flags=re.DOTALL).strip()
            return f'\n\n<div class="diagram">{svg}</div>\n\n'
        return "\n\n*(diagram render failed)*\n\n"

    swapped = re.sub(r"```mermaid[ \t]*\n(.*?)\n```", render, text, flags=re.DOTALL)
    body_html = mdlib.markdown(swapped, extensions=["tables", "fenced_code", "toc"])
    full = f"<!doctype html><html><head><meta charset='utf-8'><style>{_CSS}</style></head><body>{body_html}</body></html>"
    html_path = Path(_WORKDIR) / "report.html"
    html_path.write_text(full, encoding="utf-8")

    if pdf_path.exists():
        pdf_path.unlink()
    # Plain file path, minimal flags, and INHERIT Chrome's stdio. Redirecting
    # headless Chrome's stdout/stderr (pipes OR devnull) triggers an
    # "Invalid file descriptor to ICU data" error on Windows; inheriting works.
    cmd = [chrome, "--headless", "--disable-gpu", "--no-sandbox",
           f"--print-to-pdf={pdf_path}", str(html_path)]
    # close_fds=False preserves the ICU-data file descriptor headless Chrome
    # expects; closing it yields "Invalid file descriptor to ICU data received".
    try:
        subprocess.run(cmd, close_fds=False, timeout=180)
    except Exception:
        pass
    if pdf_path.exists():
        return True, str(pdf_path)
    # Fallback: launch via the shell (mirrors a working terminal invocation).
    try:
        subprocess.run(" ".join(f'"{c}"' for c in cmd), shell=True, close_fds=False, timeout=180)
    except Exception:
        pass
    if pdf_path.exists():
        return True, str(pdf_path)
    return False, "chrome did not produce a PDF"


# --------------------------------------------------------------------------- #
def finalize(md_path, make_pdf: bool = True, use_mmdc: bool = True) -> dict:
    md_path = Path(md_path)
    text = md_path.read_text(encoding="utf-8")
    cleaned, report = clean_markdown(text, use_mmdc=use_mmdc)
    if cleaned != text:
        md_path.write_text(cleaned, encoding="utf-8")
    result = {"md": str(md_path), "diagram_actions": report, "pdf": None, "pdf_status": "skipped"}
    if make_pdf:
        pdf_path = md_path.with_suffix(".pdf")
        ok, info = to_pdf(md_path, pdf_path)
        result["pdf"] = info if ok else None
        result["pdf_status"] = "ok" if ok else f"failed: {info}"
    return result


if __name__ == "__main__":
    import json
    p = sys.argv[1]
    no_pdf = "--no-pdf" in sys.argv
    print(json.dumps(finalize(p, make_pdf=not no_pdf), indent=2))
