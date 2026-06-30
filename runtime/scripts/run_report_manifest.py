"""Direct sequential runner for report-swarm manifests (single-laptop path).

Loads a rendered SwarmManifest, executes its tasks in wave order against the
configured local model via ``benny.core.models.call_model`` (the same path the
swarm executor uses), threading each task's output forward as handover context.
The final ``output`` task assembles the document and writes it to the manifest's
output file.

This is the deterministic, observable alternative to the LangGraph swarm
executor for long-form report generation on one machine: no orchestrator/JIT
expansion, one model call per declared task, hard per-call timeouts, live
progress. Use it to eval a report manifest end-to-end:

    python scripts/run_report_manifest.py manifests/togaf_sad_prime_silo.json
"""
from __future__ import annotations

import asyncio
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import benny_cli  # noqa: E402  — reuse _render_manifest_vars / _load_manifest
from benny.core.manifest import SwarmManifest  # noqa: E402
from benny.core.models import call_model  # noqa: E402
from benny.core.workspace import get_workspace_path  # noqa: E402

import os

# qwen3.5-9b-FLM generates ~6 tok/s on this laptop and serializes one request
# at a time. Diagram-dense tasks need more room, so make the budget tunable.
# REPORT_MAX_TOKENS default 1500 (~250s); REPORT_CALL_TIMEOUT default 360s.
PER_CALL_TIMEOUT_S = int(os.environ.get("REPORT_CALL_TIMEOUT", "360"))
MAX_TOKENS_PER_TASK = int(os.environ.get("REPORT_MAX_TOKENS", "1500"))
# Optional grounding file: its content is prepended to every task's context so
# the local model writes about the REAL system instead of inventing one.
GROUNDING_FILE = os.environ.get("REPORT_GROUNDING", "")

# Diagram authoring rules — enforced in the prompt so the model emits ONLY
# portable diagrams. The finalize pass (report_finalize.py) validates and drops
# anything that slips through, but getting it right here keeps the report whole.
DIAGRAM_RULES = (
    "DIAGRAM RULES: Mermaid only in ```mermaid blocks (close each with ``` on its own line). "
    "Allowed: flowchart, graph, sequenceDiagram, classDiagram, erDiagram. NO PlantUML, NO Mermaid C4 "
    "(render C4 as flowchart TB with subgraphs; use-cases as flowchart LR). No parentheses inside "
    "[node labels]; unique node IDs; quote reserved erDiagram names \"Class\"/\"Function\"."
)


_GROUNDING_CACHE = None


# Local FLM models have a small (~4k token) context window. Keep the per-call
# prompt compact so the model has room to actually generate: when input grew
# past ~3900 tokens the model returned empty / "no choices". These caps keep
# input well under that ceiling.
GROUNDING_MAXCHARS = int(os.environ.get("REPORT_GROUNDING_MAXCHARS", "2600"))
HANDOVER_MAXCHARS = int(os.environ.get("REPORT_HANDOVER_MAXCHARS", "900"))


def _grounding_text() -> str:
    global _GROUNDING_CACHE
    if _GROUNDING_CACHE is None:
        _GROUNDING_CACHE = ""
        if GROUNDING_FILE and Path(GROUNDING_FILE).exists():
            _GROUNDING_CACHE = Path(GROUNDING_FILE).read_text(encoding="utf-8")[:GROUNDING_MAXCHARS]
    return _GROUNDING_CACHE


def _wave_order(manifest: SwarmManifest):
    """Return tasks grouped by wave (falling back to topo-by-dependencies)."""
    tasks = {t.id: t for t in manifest.plan.tasks}
    if manifest.plan.waves:
        return [[tasks[tid] for tid in wave if tid in tasks] for wave in manifest.plan.waves]
    # Fallback: single wave in declared order.
    return [list(manifest.plan.tasks)]


async def _run_task(task, manifest, context: str) -> str:
    model = task.assigned_model or manifest.config.model
    persona = getattr(task, "persona", None) or ""
    system = (
        f"You are the '{persona or task.node_type}' agent in a TOGAF report swarm. "
        f"Produce a rigorous, information-dense, MULTI-PARAGRAPH Markdown section for your "
        f"assigned step. Be comprehensive and specific; include the required diagrams. "
        f"Do not restate prior sections."
    )
    grounding = _grounding_text()
    grounding_block = f"GROUNDING (authoritative facts — use these, do not invent):\n{grounding}\n\n" if grounding else ""
    user = (
        f"{grounding_block}"
        f"YOUR TASK ({task.id}):\n{task.description}\n\n"
        f"SECTIONS ALREADY WRITTEN (do not repeat them):\n{context[:HANDOVER_MAXCHARS] or '(none yet)'}\n\n"
        f"Write a thorough section now.\n{DIAGRAM_RULES}"
    )
    t0 = time.monotonic()
    out = await asyncio.wait_for(
        call_model(
            model,
            [{"role": "system", "content": system}, {"role": "user", "content": user}],
            temperature=0.4,
            max_tokens=MAX_TOKENS_PER_TASK,
            run_id=f"report-{manifest.id}",
        ),
        timeout=PER_CALL_TIMEOUT_S,
    )
    dt = time.monotonic() - t0
    out = (out or "").strip()
    print(f"  [{task.id}] {persona or task.node_type}: {len(out)} chars in {dt:.1f}s", flush=True)
    return out


async def main(manifest_path: str) -> int:
    manifest = benny_cli._load_manifest(manifest_path, overrides=None)
    print(f"[report] manifest={manifest.id} model={manifest.config.model} tasks={len(manifest.plan.tasks)}", flush=True)

    sections: dict[str, str] = {}
    done_titles: list[str] = []
    last_excerpt = ""
    overall_t0 = time.monotonic()
    for wi, wave in enumerate(_wave_order(manifest)):
        for task in wave:
            print(f"wave {wi}: running {task.id} ...", flush=True)
            # Compact handover: just the list of completed sections plus a short
            # excerpt of the previous one. Keeps the prompt within the local
            # model's small context window (full-content handover overflowed it).
            handover = "Done so far: " + (", ".join(done_titles) or "(none)")
            if last_excerpt:
                handover += f"\n\nPrevious section opened with:\n{last_excerpt}"
            try:
                sections[task.id] = await _run_task(task, manifest, handover)
            except asyncio.TimeoutError:
                sections[task.id] = f"_(task {task.id} timed out after {PER_CALL_TIMEOUT_S}s)_"
                print(f"  [{task.id}] TIMEOUT", flush=True)
            done_titles.append(task.id)
            last_excerpt = " ".join(sections[task.id].split())[:500]

    # Assemble final document (the editorial/output task's text leads if present).
    out_files = manifest.outputs.files or ["data_out/report.md"]
    out_rel = out_files[0]
    out_path = get_workspace_path(manifest.workspace) / out_rel
    out_path.parent.mkdir(parents=True, exist_ok=True)

    body_parts = [f"# {manifest.name}\n", f"_Generated by {manifest.config.model} — direct sequential runner_\n"]
    for task in manifest.plan.tasks:
        body_parts.append(f"\n## {task.id}\n\n{sections.get(task.id, '').strip()}\n")
    out_path.write_text("\n".join(body_parts), encoding="utf-8")

    total = time.monotonic() - overall_t0
    words = sum(len(s.split()) for s in sections.values())
    print(f"\n[report] DONE in {total:.1f}s — {words} words -> {out_path}", flush=True)
    print(f"[report] target was {manifest.outputs.word_count_target} words", flush=True)

    # Finalize: validate/repair every diagram (drop anything non-portable so the
    # document is always clean) and render a PDF. Controlled by REPORT_FINALIZE
    # (default on) and REPORT_PDF (default on).
    if os.environ.get("REPORT_FINALIZE", "1") != "0":
        try:
            from report_finalize import finalize  # scripts/ is on sys.path via this file
        except Exception:
            sys.path.insert(0, str(Path(__file__).resolve().parent))
            from report_finalize import finalize
        print("[report] finalizing (diagram validation + PDF) ...", flush=True)
        res = finalize(out_path, make_pdf=os.environ.get("REPORT_PDF", "1") != "0")
        for action, detail in res.get("diagram_actions", []):
            print(f"  [finalize] {action}: {detail}", flush=True)
        if not res.get("diagram_actions"):
            print("  [finalize] all diagrams valid — nothing to repair", flush=True)
        print(f"  [finalize] PDF: {res.get('pdf_status')}"
              + (f" -> {res['pdf']}" if res.get('pdf') else ""), flush=True)
    return 0


if __name__ == "__main__":
    mp = sys.argv[1] if len(sys.argv) > 1 else "manifests/togaf_sad_prime_silo.json"
    raise SystemExit(asyncio.run(main(mp)))
