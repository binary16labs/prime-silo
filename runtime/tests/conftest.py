"""Shared fixtures for Benny's test suite."""
from __future__ import annotations

from pathlib import Path

import pytest


@pytest.fixture(scope="session")
def repo_root() -> Path:
    """Absolute path to the repository root."""
    return Path(__file__).resolve().parent.parent
