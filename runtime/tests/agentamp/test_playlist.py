"""AAMP-001 Phase 6 — Playlist data layer acceptance tests.

Covers
------
  AAMP-F11  test_aamp_f11_playlist_reads_runs
  AAMP-F12  test_aamp_f12_enqueue_uses_runs_endpoint
"""

from __future__ import annotations

import json
from io import BytesIO
from typing import Any, Dict, List
from unittest.mock import MagicMock, patch

import pytest

from benny.agentamp.playlist import PlaylistEntry, enqueue_manifest, get_playlist


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_run_record(
    run_id: str = "run-abc123",
    manifest_id: str = "manifest-1",
    workspace: str = "default",
    status: str = "completed",
    duration_ms: int = 1234,
    model: str = "gpt-4o",
) -> Any:
    """Return a minimal RunRecord-like object for use in mocks."""
    rec = MagicMock()
    rec.run_id = run_id
    rec.manifest_id = manifest_id
    rec.workspace = workspace
    rec.status = MagicMock()
    rec.status.value = status
    rec.started_at = "2026-04-01T00:00:00"
    rec.completed_at = "2026-04-01T00:00:01"
    rec.duration_ms = duration_ms
    rec.manifest_snapshot = {"config": {"model": model}}
    return rec


# ---------------------------------------------------------------------------
# AAMP-F11 — playlist reads runs
# ---------------------------------------------------------------------------


class TestPlaylistReadsRuns:
    """test_aamp_f11_playlist_reads_runs: playlist reads benny runs history."""

    def test_returns_playlist_entries(self) -> None:
        """get_playlist returns PlaylistEntry objects from the run_store."""
        records = [
            _make_run_record("run-1", model="gpt-4o"),
            _make_run_record("run-2", status="running", model="gpt-4o-mini"),
        ]
        with patch("benny.agentamp.playlist.run_store") as mock_store:
            mock_store.list_runs.return_value = records
            entries = get_playlist(workspace="default", limit=10)

        assert len(entries) == 2
        assert all(isinstance(e, PlaylistEntry) for e in entries)

    def test_fields_mapped_correctly(self) -> None:
        """Playlist entry fields map 1:1 from RunRecord fields."""
        rec = _make_run_record(
            run_id="run-xyz",
            manifest_id="m-99",
            workspace="ws-A",
            status="completed",
            duration_ms=5000,
            model="claude-3",
        )
        with patch("benny.agentamp.playlist.run_store") as mock_store:
            mock_store.list_runs.return_value = [rec]
            entries = get_playlist()

        e = entries[0]
        assert e.run_id == "run-xyz"
        assert e.manifest_id == "m-99"
        assert e.workspace == "ws-A"
        assert e.status == "completed"
        assert e.duration_ms == 5000
        assert e.model == "claude-3"
        assert e.cost_usd is None  # not yet tracked

    def test_empty_store_returns_empty_list(self) -> None:
        with patch("benny.agentamp.playlist.run_store") as mock_store:
            mock_store.list_runs.return_value = []
            entries = get_playlist()
        assert entries == []

    def test_workspace_filter_forwarded(self) -> None:
        """get_playlist forwards the workspace kwarg to run_store.list_runs."""
        with patch("benny.agentamp.playlist.run_store") as mock_store:
            mock_store.list_runs.return_value = []
            get_playlist(workspace="my-ws", limit=25)
            mock_store.list_runs.assert_called_once_with(workspace="my-ws", limit=25)

    def test_missing_model_in_snapshot(self) -> None:
        """Playlist entry model is None when manifest snapshot has no config."""
        rec = _make_run_record()
        rec.manifest_snapshot = {}  # no config key
        with patch("benny.agentamp.playlist.run_store") as mock_store:
            mock_store.list_runs.return_value = [rec]
            entries = get_playlist()
        assert entries[0].model is None

    def test_status_string_extracted_from_enum(self) -> None:
        """Status is the .value string of a RunStatus enum-like object."""
        rec = _make_run_record(status="running")
        rec.status.value = "running"
        with patch("benny.agentamp.playlist.run_store") as mock_store:
            mock_store.list_runs.return_value = [rec]
            entries = get_playlist()
        assert entries[0].status == "running"


# ---------------------------------------------------------------------------
# AAMP-F12 — enqueue uses /api/run endpoint
# ---------------------------------------------------------------------------


class TestEnqueueUsesRunsEndpoint:
    """test_aamp_f12_enqueue_uses_runs_endpoint: enqueue dispatches via /api/run."""

    def _make_http_response(self, run_id: str = "run-new-123") -> MagicMock:
        """Return a mock urllib response that yields the given run_id."""
        body = json.dumps({"run_id": run_id}).encode("utf-8")
        resp = MagicMock()
        resp.read.return_value = body
        resp.__enter__ = lambda s: s
        resp.__exit__ = MagicMock(return_value=False)
        return resp

    def test_posts_to_api_run_endpoint(self) -> None:
        """enqueue_manifest POSTs to /api/run at the given api_base."""
        resp = self._make_http_response("run-abc")

        with patch("benny.agentamp.playlist.urllib.request.urlopen", return_value=resp) as mock_open, \
             patch("benny.agentamp.playlist.urllib.request.Request") as mock_req:
            mock_req.return_value = MagicMock()
            result = enqueue_manifest(
                {"id": "m1", "workspace": "default"},
                api_base="http://test-server:9000",
                api_key="test-key",
            )

        # URL should be http://test-server:9000/api/run
        call_args = mock_req.call_args
        url_arg = call_args[0][0]
        assert url_arg == "http://test-server:9000/api/run"

    def test_sets_api_key_header(self) -> None:
        """enqueue_manifest passes X-Benny-API-Key in the request headers."""
        resp = self._make_http_response()

        with patch("benny.agentamp.playlist.urllib.request.urlopen", return_value=resp), \
             patch("benny.agentamp.playlist.urllib.request.Request") as mock_req:
            mock_req.return_value = MagicMock()
            enqueue_manifest(
                {"id": "m1"},
                api_key="custom-key-42",
            )

        headers = mock_req.call_args[1]["headers"]
        assert headers["X-Benny-API-Key"] == "custom-key-42"
        assert headers["Content-Type"] == "application/json"

    def test_returns_run_id(self) -> None:
        """enqueue_manifest returns the run_id from the server response."""
        resp = self._make_http_response("run-expected")
        with patch("benny.agentamp.playlist.urllib.request.urlopen", return_value=resp), \
             patch("benny.agentamp.playlist.urllib.request.Request") as mock_req:
            mock_req.return_value = MagicMock()
            run_id = enqueue_manifest({"id": "m1"})
        assert run_id == "run-expected"

    def test_uses_post_method(self) -> None:
        """enqueue_manifest constructs the request with method=POST."""
        resp = self._make_http_response()
        with patch("benny.agentamp.playlist.urllib.request.urlopen", return_value=resp), \
             patch("benny.agentamp.playlist.urllib.request.Request") as mock_req:
            mock_req.return_value = MagicMock()
            enqueue_manifest({"id": "m1"})

        kwargs = mock_req.call_args[1]
        assert kwargs.get("method") == "POST"

    def test_body_is_json(self) -> None:
        """enqueue_manifest serialises the manifest dict as JSON in the body."""
        resp = self._make_http_response()
        manifest: Dict[str, Any] = {"id": "m1", "schema_version": "1.0"}
        with patch("benny.agentamp.playlist.urllib.request.urlopen", return_value=resp), \
             patch("benny.agentamp.playlist.urllib.request.Request") as mock_req:
            mock_req.return_value = MagicMock()
            enqueue_manifest(manifest)

        body_bytes = mock_req.call_args[1]["data"]
        parsed = json.loads(body_bytes.decode("utf-8"))
        assert parsed["id"] == "m1"
        assert parsed["schema_version"] == "1.0"

    def test_workspace_injected_into_payload(self) -> None:
        """enqueue_manifest sets the workspace field in the posted payload."""
        resp = self._make_http_response()
        with patch("benny.agentamp.playlist.urllib.request.urlopen", return_value=resp), \
             patch("benny.agentamp.playlist.urllib.request.Request") as mock_req:
            mock_req.return_value = MagicMock()
            enqueue_manifest({"id": "m1"}, workspace="prod")

        body_bytes = mock_req.call_args[1]["data"]
        parsed = json.loads(body_bytes.decode("utf-8"))
        assert parsed["workspace"] == "prod"
