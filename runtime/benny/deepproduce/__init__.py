"""Deep-produce — orchestrated multi-panel view generation.

Turns one goal into a composite ``.aamp.view`` by fanning out a model call per
panel and synthesizing the results, recorded as a run with per-stage governance
events so the Bridge Runs trace (lineage_timeline + reasoning_trace) shows the
fan-out. See :mod:`benny.deepproduce.producer`.
"""

from .producer import deep_produce, load_run_result

__all__ = ["deep_produce", "load_run_result"]
