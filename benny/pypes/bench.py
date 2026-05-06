"""Side-by-side performance benchmarking for pypes manifests.

Runs two (or more) manifests sequentially over the same workspace and
captures, per run:

* wall-clock duration                                          (seconds)
* peak resident set size of the Python process                 (MB)
* mean / max process CPU usage during the run                  (%)
* per-step timings extracted from the RunReceipt
* row-count fingerprint of every step's output                 (parity check)

The intended use is to compare engines (pandas vs polars on the same DAG)
or shapes (single-stage vs unioned), but the harness is engine-agnostic —
any pair of valid pypes manifests works.

Cost
----
For local execution, monetary cost is dominated by wall-clock CPU. We
report ``cpu_seconds`` and an optional ``cost_usd`` derived from
``$BENNY_COMPUTE_COST_USD_PER_HOUR`` (default $0.20/hr — a conservative
self-hosted laptop rate). When you wire this up to a paid cloud SKU,
override the env var and the column updates automatically.
"""

from __future__ import annotations

import logging
import os
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional

import psutil

from .models import PypesManifest, RunReceipt
from .orchestrator import Orchestrator, load_manifest

log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# RESULT CONTAINER
# ---------------------------------------------------------------------------


@dataclass
class BenchResult:
    label: str
    manifest_path: str
    manifest_id: str
    engine: str  # The dominant engine across the manifest's steps
    wall_seconds: float
    cpu_seconds: float
    cpu_percent_mean: float
    cpu_percent_max: float
    rss_mb_baseline: float
    rss_mb_peak: float
    rss_mb_delta: float
    samples: int
    receipt: Optional[RunReceipt] = None
    error: Optional[str] = None
    step_durations: Dict[str, float] = field(default_factory=dict)

    @property
    def status(self) -> str:
        if self.error:
            return "FAILED"
        return self.receipt.status if self.receipt else "?"

    @property
    def total_rows(self) -> int:
        if not self.receipt:
            return 0
        return sum((r.row_count or 0) for r in self.receipt.step_results.values())

    @property
    def cost_usd(self) -> float:
        rate = float(os.environ.get("BENNY_COMPUTE_COST_USD_PER_HOUR", "0.20"))
        return round(self.wall_seconds / 3600.0 * rate, 6)


# ---------------------------------------------------------------------------
# SAMPLER
# ---------------------------------------------------------------------------


class _ResourceSampler:
    """Background thread that samples Process RSS + CPU% at a fixed interval.

    psutil's ``cpu_percent(interval=None)`` returns CPU usage since the
    *previous* call on the same Process object, so we prime it once before
    starting the sampling loop.
    """

    def __init__(self, interval_seconds: float = 0.05) -> None:
        self.interval = interval_seconds
        self.proc = psutil.Process(os.getpid())
        # Prime CPU counter so the first non-zero reading is meaningful.
        self.proc.cpu_percent(interval=None)
        self._thread: Optional[threading.Thread] = None
        self._stop = threading.Event()
        self.cpu_samples: List[float] = []
        self.rss_samples_mb: List[float] = []
        self._cpu_total_at_start: float = 0.0
        self._cpu_total_at_stop: float = 0.0
        self.baseline_rss_mb: float = 0.0

    def __enter__(self) -> "_ResourceSampler":
        self.baseline_rss_mb = self.proc.memory_info().rss / (1024 * 1024)
        cpu = self.proc.cpu_times()
        self._cpu_total_at_start = cpu.user + cpu.system
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()
        return self

    def __exit__(self, exc_type, exc_val, exc_tb) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=1.0)
        cpu = self.proc.cpu_times()
        self._cpu_total_at_stop = cpu.user + cpu.system

    def _loop(self) -> None:
        while not self._stop.is_set():
            try:
                self.cpu_samples.append(self.proc.cpu_percent(interval=None))
                self.rss_samples_mb.append(self.proc.memory_info().rss / (1024 * 1024))
            except Exception:
                break
            time.sleep(self.interval)

    @property
    def cpu_seconds(self) -> float:
        return max(0.0, self._cpu_total_at_stop - self._cpu_total_at_start)

    @property
    def cpu_percent_mean(self) -> float:
        if not self.cpu_samples:
            return 0.0
        non_zero = [s for s in self.cpu_samples if s > 0]
        return round(sum(non_zero) / len(non_zero), 2) if non_zero else 0.0

    @property
    def cpu_percent_max(self) -> float:
        return round(max(self.cpu_samples or [0.0]), 2)

    @property
    def rss_peak_mb(self) -> float:
        return round(max(self.rss_samples_mb or [self.baseline_rss_mb]), 2)


# ---------------------------------------------------------------------------
# RUN ONE
# ---------------------------------------------------------------------------


def _dominant_engine(m: PypesManifest) -> str:
    counts: Dict[str, int] = {}
    for s in m.steps:
        counts[s.engine.value] = counts.get(s.engine.value, 0) + 1
    return max(counts.items(), key=lambda kv: kv[1])[0] if counts else "?"


def _step_durations(receipt: RunReceipt) -> Dict[str, float]:
    """Even split of wall time across executed steps (orchestrator doesn't
    surface per-step timings in the receipt yet — bench-level estimate)."""
    if not receipt or not receipt.step_results:
        return {}
    n = len(receipt.step_results)
    if not n or not receipt.duration_ms:
        return {}
    avg = receipt.duration_ms / n / 1000.0
    return {sid: round(avg, 4) for sid in receipt.step_results.keys()}


def run_one(
    manifest_path: str,
    label: str,
    *,
    workspace: Optional[str] = None,
    sample_interval: float = 0.05,
    warmup: bool = True,
) -> BenchResult:
    """Execute ``manifest_path`` once with full resource sampling around it."""
    manifest = load_manifest(manifest_path)
    if workspace:
        manifest.workspace = workspace

    # Best-effort warmup: load CSV / engine import cost shouldn't dominate the headline number.
    if warmup:
        try:
            from .engines import get_engine
            from .models import EngineType
            for s in manifest.steps:
                if s.engine.value == "polars":
                    get_engine(EngineType.POLARS)
                else:
                    get_engine(EngineType.PANDAS)
        except Exception as exc:  # pragma: no cover
            log.debug("bench: warmup skipped (%s)", exc)

    error: Optional[str] = None
    receipt: Optional[RunReceipt] = None
    t0 = time.perf_counter()
    with _ResourceSampler(interval_seconds=sample_interval) as sampler:
        try:
            receipt = Orchestrator().run(manifest)
        except Exception as exc:  # pragma: no cover
            log.exception("bench: %s failed", label)
            error = str(exc)
    wall = time.perf_counter() - t0

    return BenchResult(
        label=label,
        manifest_path=str(Path(manifest_path).resolve()),
        manifest_id=manifest.id,
        engine=_dominant_engine(manifest),
        wall_seconds=round(wall, 4),
        cpu_seconds=round(sampler.cpu_seconds, 4),
        cpu_percent_mean=sampler.cpu_percent_mean,
        cpu_percent_max=sampler.cpu_percent_max,
        rss_mb_baseline=round(sampler.baseline_rss_mb, 2),
        rss_mb_peak=sampler.rss_peak_mb,
        rss_mb_delta=round(sampler.rss_peak_mb - sampler.baseline_rss_mb, 2),
        samples=len(sampler.cpu_samples),
        receipt=receipt,
        error=error,
        step_durations=_step_durations(receipt) if receipt else {},
    )


# ---------------------------------------------------------------------------
# RUN MANY
# ---------------------------------------------------------------------------


def run_bench(
    pairs: List[tuple],  # [(label, manifest_path), ...]
    *,
    workspace: Optional[str] = None,
    repeats: int = 1,
    sample_interval: float = 0.05,
) -> List[BenchResult]:
    """Run each (label, manifest) pair sequentially ``repeats`` times.

    Best-of-``repeats`` is selected per label so a transient OS hiccup
    on the first run doesn't poison the comparison.
    """
    by_label: Dict[str, List[BenchResult]] = {}
    for label, path in pairs:
        for i in range(repeats):
            r = run_one(path, label=f"{label}#{i+1}" if repeats > 1 else label,
                        workspace=workspace, sample_interval=sample_interval)
            by_label.setdefault(label, []).append(r)

    # Pick best (lowest wall) per label, restore original label.
    best: List[BenchResult] = []
    for label, runs in by_label.items():
        winner = min(runs, key=lambda r: r.wall_seconds)
        winner.label = label
        best.append(winner)
    return best


# ---------------------------------------------------------------------------
# COMPARISON HELPERS
# ---------------------------------------------------------------------------


def parity_diff(results: List[BenchResult]) -> List[Dict[str, Any]]:
    """Return per-step row-count differences across runs.

    A non-empty list means the two engines disagree on at least one step's
    row count and the bench winner is misleading — investigate before trusting
    the headline.
    """
    if len(results) < 2:
        return []
    base = results[0]
    if not base.receipt:
        return []
    diffs: List[Dict[str, Any]] = []
    for step_id, vr in base.receipt.step_results.items():
        row = {"step": step_id, base.label: vr.row_count}
        differs = False
        for other in results[1:]:
            if not other.receipt:
                continue
            other_vr = other.receipt.step_results.get(step_id)
            other_count = other_vr.row_count if other_vr else None
            row[other.label] = other_count
            if other_count != vr.row_count:
                differs = True
        if differs:
            diffs.append(row)
    return diffs


def speedup_vs(reference: BenchResult, other: BenchResult) -> float:
    """``reference / other`` — values > 1 mean ``other`` is faster."""
    if other.wall_seconds <= 0:
        return 0.0
    return round(reference.wall_seconds / other.wall_seconds, 3)
