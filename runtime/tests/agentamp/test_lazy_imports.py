"""benny.agentamp keeps a lazy public surface (PEP 562).

Importing anything from this package used to drag in the whole LLM stack:
``__init__`` eagerly imported all eleven submodules, and ``playlist`` pulls
``..persistence.run_store`` -> ``..persistence.checkpointer`` ->
``langgraph.checkpoint.base`` -> langchain_core / langsmith / opentelemetry.
That cost ``from benny.agentamp.coord import cmd_coord`` 3.3-5.3s on this
OneDrive-synced tree against 0.51s after, which made `benny coord` unusable
as a CLI.

These tests are the guard. The last one is the one that matters: it runs a
FRESH interpreter, because by the time the suite reaches this file some other
test has almost certainly imported playlist already, and asserting against this
process's sys.modules would pass vacuously.
"""

from __future__ import annotations

import subprocess
import sys
import textwrap

import pytest

import benny.agentamp as agentamp

# Anything here means the LLM/persistence stack was pulled in at import time.
HEAVY = (
    "langchain_core",
    "langsmith",
    "litellm",
    "opentelemetry",
    "benny.persistence",
    "benny.agentamp.playlist",
)


def test_exports_map_and_all_agree():
    """A name in one but not the other is a latent AttributeError. Fail loudly here."""
    assert set(agentamp._EXPORTS) == set(agentamp.__all__)


@pytest.mark.parametrize("name", sorted(agentamp.__all__))
def test_every_public_name_still_resolves(name):
    """The lazy surface must expose exactly what the eager one did."""
    assert getattr(agentamp, name) is not None


def test_unknown_attribute_raises_attribute_error():
    with pytest.raises(AttributeError, match="has no attribute"):
        agentamp.definitely_not_exported  # noqa: B018


def test_resolved_names_are_cached_in_module_globals():
    """__getattr__ caches into globals(), so repeated access is not repeated import."""
    agentamp.SkinManifest  # noqa: B018 — force resolution
    assert "SkinManifest" in vars(agentamp)


def test_importing_agentamp_does_not_pull_the_llm_stack():
    """The regression itself, in a clean interpreter.

    Mutation check for whoever verifies this: restore a module-level
    ``from .playlist import get_playlist`` in ``benny/agentamp/__init__.py`` and
    this test must go RED. If it stays green it is not testing anything.
    """
    code = textwrap.dedent(
        f"""
        import sys
        import benny.agentamp  # noqa: F401
        print(",".join(m for m in {HEAVY!r} if m in sys.modules))
        """
    )
    proc = subprocess.run(
        [sys.executable, "-c", code], capture_output=True, text=True, check=True
    )
    loaded = proc.stdout.strip()
    assert loaded == "", f"importing benny.agentamp pulled in: {loaded}"


def test_touching_a_heavy_name_still_works():
    """Lazy must not mean broken: the heavy submodule loads on demand."""
    assert agentamp.get_playlist is not None
