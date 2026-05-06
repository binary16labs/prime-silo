"""Shared fixtures and stubs for the agentamp test suite.

``openlineage``, ``attr``, and their sub-packages are optional heavy
dependencies not installed in the dev environment.  We install lightweight
stubs into ``sys.modules`` *before* any test module is imported so that
``benny.governance.lineage`` can be loaded without error.

The stubs provide just enough surface to satisfy the import-time attribute
lookups in ``lineage.py`` and ``governance/__init__.py``.  They are not
callable and will raise :exc:`NotImplementedError` if any production code
path actually tries to invoke them during tests — which would be a test
design error (agentamp unit tests must not fire real lineage events).
"""
from __future__ import annotations

import sys
import types


def _make_stub(name: str) -> types.ModuleType:
    """Return a stub module with a catch-all ``__getattr__`` that returns a
    no-op class for any attribute access."""

    class _StubClass:
        """Stub class — raises NotImplementedError if instantiated in tests."""

        def __init__(self, *a, **kw):
            raise NotImplementedError(
                f"Stub class from '{name}' should not be instantiated in tests."
            )

    class _StubModule(types.ModuleType):
        def __getattr__(self, item: str):
            # Return a class (not an instance) so `isinstance` checks and
            # subclassing work without actually calling the constructor.
            return type(item, (_StubClass,), {"__module__": name})

    mod = _StubModule(name)
    return mod


# ---------------------------------------------------------------------------
# Register stubs for optional heavy deps
# ---------------------------------------------------------------------------

_STUB_NAMES = [
    "openlineage",
    "openlineage.client",
    "openlineage.client.run",
    "openlineage.client.facet",
    "attr",
    "attrs",
    # langgraph is an optional heavy dep used by benny.persistence.checkpointer;
    # agentamp unit tests must not require it to be installed.
    "langgraph",
    "langgraph.checkpoint",
    "langgraph.checkpoint.base",
    "langgraph.checkpoint.sqlite",
    "langgraph.graph",
    "langgraph.prebuilt",
]

for _name in _STUB_NAMES:
    if _name not in sys.modules:
        sys.modules[_name] = _make_stub(_name)
