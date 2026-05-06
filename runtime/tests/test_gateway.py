"""
Test suite for Phase 4 — MCP Gateway, RBAC, Remix Servers, Credential Vault.
Run with: python -m pytest tests/test_gateway.py -v
"""

import pytest
import time
from unittest.mock import patch, MagicMock
from pathlib import Path

from benny.gateway.rbac import (
    AgentRole, ToolOperation, ToolPermission, RBACPolicy,
    check_permission, load_policy, save_policy, _rate_counters,
)
from benny.gateway.remix_server import (
    RemixServerConfig, RemixServer, save_remix_config,
    load_remix_config, list_remix_configs,
)
from benny.gateway.credential_vault import (
    store_credential, get_credential, list_credentials, delete_credential,
)


class TestRBAC:

    def setup_method(self):
        _rate_counters.clear()

    def test_admin_bypasses_all(self, tmp_path):
        with patch("benny.gateway.rbac._get_policy_path", return_value=tmp_path / "rbac.json"):
            with patch("benny.gateway.rbac.emit_governance_event"):
                result = check_permission("test", AgentRole.ADMIN, "any_tool", ToolOperation.EXECUTE)
                assert result is True

    def test_viewer_cannot_write(self, tmp_path):
        policy = RBACPolicy(permissions=[
            ToolPermission(
                tool_id="write_file",
                allowed_roles=[AgentRole.EXECUTOR, AgentRole.ADMIN],
                allowed_operations=[ToolOperation.WRITE, ToolOperation.EXECUTE],
            )
        ])
        with patch("benny.gateway.rbac._get_policy_path", return_value=tmp_path / "rbac.json"):
            save_policy("test", policy)
            with patch("benny.gateway.rbac.emit_governance_event"):
                result = check_permission("test", AgentRole.VIEWER, "write_file", ToolOperation.EXECUTE)
                assert result is False

    def test_executor_can_execute_allowed_tool(self, tmp_path):
        policy = RBACPolicy(permissions=[
            ToolPermission(
                tool_id="search_kb",
                allowed_roles=[AgentRole.EXECUTOR],
                allowed_operations=[ToolOperation.EXECUTE],
            )
        ])
        with patch("benny.gateway.rbac._get_policy_path", return_value=tmp_path / "rbac.json"):
            save_policy("test", policy)
            with patch("benny.gateway.rbac.emit_governance_event"):
                result = check_permission("test", AgentRole.EXECUTOR, "search_kb", ToolOperation.EXECUTE)
                assert result is True

    def test_unknown_tool_denied(self, tmp_path):
        with patch("benny.gateway.rbac._get_policy_path", return_value=tmp_path / "rbac.json"):
            with patch("benny.gateway.rbac.emit_governance_event"):
                result = check_permission("test", AgentRole.EXECUTOR, "totally_unknown", ToolOperation.EXECUTE)
                assert result is False

    def test_rate_limiting(self, tmp_path):
        policy = RBACPolicy(
            permissions=[
                ToolPermission(tool_id="test_tool", allowed_roles=[AgentRole.EXECUTOR], allowed_operations=[ToolOperation.EXECUTE])
            ],
            rate_limits={AgentRole.EXECUTOR: 3}
        )
        with patch("benny.gateway.rbac._get_policy_path", return_value=tmp_path / "rbac.json"):
            save_policy("test", policy)
            with patch("benny.gateway.rbac.emit_governance_event"):
                assert check_permission("test", AgentRole.EXECUTOR, "test_tool", ToolOperation.EXECUTE, "agent1") is True
                assert check_permission("test", AgentRole.EXECUTOR, "test_tool", ToolOperation.EXECUTE, "agent1") is True
                assert check_permission("test", AgentRole.EXECUTOR, "test_tool", ToolOperation.EXECUTE, "agent1") is True
                assert check_permission("test", AgentRole.EXECUTOR, "test_tool", ToolOperation.EXECUTE, "agent1") is False


class TestRemixServer:

    def test_execute_in_scope(self):
        config = RemixServerConfig(id="test", name="Test", skill_ids=["search_kb"], workspace="default")
        server = RemixServer(config)
        
        with patch("benny.gateway.remix_server.check_permission", return_value=True):
            with patch("benny.gateway.remix_server.registry") as mock_reg:
                mock_reg.execute_skill.return_value = "Search results..."
                mock_reg.get_skills_by_ids.return_value = []
                result = server.execute("search_kb", "default")
                assert result.success is True
                assert result.output == "Search results..."

    def test_execute_out_of_scope(self):
        config = RemixServerConfig(id="test", name="Test", skill_ids=["search_kb"], workspace="default")
        server = RemixServer(config)
        result = server.execute("write_file", "default")
        assert result.success is False
        assert "not available" in result.error

    def test_session_limit(self):
        config = RemixServerConfig(id="test", name="Test", skill_ids=["search_kb"], max_calls_per_session=2, workspace="default")
        server = RemixServer(config)
        
        with patch("benny.gateway.remix_server.check_permission", return_value=True):
            with patch("benny.gateway.remix_server.registry") as mock_reg:
                mock_reg.execute_skill.return_value = "ok"
                mock_reg.get_skills_by_ids.return_value = []
                server.execute("search_kb", "default")
                server.execute("search_kb", "default")
                result = server.execute("search_kb", "default")
                assert result.success is False
                assert "limit" in result.error.lower()

    def test_save_and_load_config(self, tmp_path):
        config = RemixServerConfig(id="rag_only", name="RAG Only", skill_ids=["search_kb"], workspace="default")
        with patch("benny.gateway.remix_server._remix_configs_dir", return_value=tmp_path):
            save_remix_config(config)
            loaded = load_remix_config("default", "rag_only")
            assert loaded is not None
            assert loaded.name == "RAG Only"

    def test_list_configs(self, tmp_path):
        c1 = RemixServerConfig(id="a", name="A", skill_ids=[], workspace="default")
        c2 = RemixServerConfig(id="b", name="B", skill_ids=[], workspace="default")
        with patch("benny.gateway.remix_server._remix_configs_dir", return_value=tmp_path):
            save_remix_config(c1)
            save_remix_config(c2)
            configs = list_remix_configs("default")
            assert len(configs) == 2


class TestCredentialVault:

    def test_store_and_retrieve(self, tmp_path):
        with patch("benny.gateway.credential_vault._vault_path", return_value=tmp_path / "vault.json"):
            with patch("benny.gateway.credential_vault.emit_governance_event"):
                store_credential("test", "api_key", "sk-12345")
                value = get_credential("test", "api_key")
                assert value == "sk-12345"

    def test_get_nonexistent(self, tmp_path):
        with patch("benny.gateway.credential_vault._vault_path", return_value=tmp_path / "vault.json"):
            with patch("benny.gateway.credential_vault.emit_governance_event"):
                value = get_credential("test", "nonexistent")
                assert value is None

    def test_delete_credential(self, tmp_path):
        with patch("benny.gateway.credential_vault._vault_path", return_value=tmp_path / "vault.json"):
            with patch("benny.gateway.credential_vault.emit_governance_event"):
                store_credential("test", "key", "value")
                delete_credential("test", "key")
                assert get_credential("test", "key") is None

    def test_list_credentials(self, tmp_path):
        with patch("benny.gateway.credential_vault._vault_path", return_value=tmp_path / "vault.json"):
            with patch("benny.gateway.credential_vault.emit_governance_event"):
                store_credential("test", "key1", "v1")
                store_credential("test", "key2", "v2")
                names = list_credentials("test")
                assert set(names) == {"key1", "key2"}
