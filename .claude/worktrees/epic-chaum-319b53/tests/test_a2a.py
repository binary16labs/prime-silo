"""
Test suite for Phase 3 — Agent2Agent Protocol.
Run with: python -m pytest tests/test_a2a.py -v
"""

import pytest
import asyncio
from unittest.mock import patch, AsyncMock, MagicMock

from benny.a2a.models import (
    AgentCard, AgentSkillCard, A2ATask, A2AMessage,
    A2AArtifact, UXPart, PartType, TaskState,
    JsonRpcRequest, JsonRpcResponse,
)
from benny.a2a.registry import AgentRegistry


class TestA2AModels:

    def test_agent_card_serialization(self):
        card = AgentCard(name="Test", description="Test agent", url="http://localhost:8005")
        data = card.model_dump()
        assert data["name"] == "Test"
        assert data["protocol_version"] == "0.2"

    def test_task_creation(self):
        task = A2ATask()
        assert task.status == TaskState.SUBMITTED
        assert len(task.id) > 0

    def test_message_text_convenience(self):
        msg = A2AMessage.text("user", "Hello")
        assert msg.role == "user"
        assert len(msg.parts) == 1
        assert msg.parts[0].type == PartType.TEXT
        assert msg.parts[0].content == "Hello"

    def test_json_rpc_request(self):
        req = JsonRpcRequest(method="tasks/send", params={"message": "test"})
        assert req.jsonrpc == "2.0"
        assert req.method == "tasks/send"

    def test_task_state_transitions(self):
        task = A2ATask()
        assert task.status == TaskState.SUBMITTED
        task.status = TaskState.WORKING
        assert task.status == TaskState.WORKING
        task.status = TaskState.COMPLETED
        assert task.status == TaskState.COMPLETED


class TestAgentRegistry:

    def test_register_and_list(self, tmp_path):
        registry = AgentRegistry()
        card = AgentCard(name="Remote", description="Remote agent", url="http://remote:8005")
        
        with patch.object(registry, '_agents_dir', return_value=tmp_path):
            result = registry.register_agent("test", card)
            assert result["status"] == "registered"
            
            agents = registry.list_agents("test")
            assert len(agents) == 1
            assert agents[0].name == "Remote"

    def test_find_agent_for_skill(self, tmp_path):
        registry = AgentRegistry()
        card = AgentCard(
            name="SearchAgent", 
            description="Agent with search", 
            url="http://search:8005",
            skills=[AgentSkillCard(id="web_search", name="Web Search", description="Search the web")]
        )
        
        with patch.object(registry, '_agents_dir', return_value=tmp_path):
            registry.register_agent("test", card)
            found = registry.find_agent_for_skill("test", "web_search")
            assert found is not None
            assert found.name == "SearchAgent"

    def test_find_nonexistent_skill(self, tmp_path):
        registry = AgentRegistry()
        with patch.object(registry, '_agents_dir', return_value=tmp_path):
            found = registry.find_agent_for_skill("test", "nonexistent")
            assert found is None

    def test_remove_agent(self, tmp_path):
        registry = AgentRegistry()
        card = AgentCard(name="Temp", description="Temp", url="http://temp:8005")
        
        with patch.object(registry, '_agents_dir', return_value=tmp_path):
            result = registry.register_agent("test", card)
            agent_id = result["agent_id"]
            
            remove_result = registry.remove_agent("test", agent_id)
            assert remove_result["status"] == "removed"
            
            agents = registry.list_agents("test")
            assert len(agents) == 0


class TestA2AClient:

    @pytest.mark.asyncio
    async def test_discover_agent(self):
        from benny.a2a.client import A2AClient
        
        mock_card = {"name": "Test", "description": "Test", "url": "http://test:8005", "skills": [], "version": "1.0.0", "protocol_version": "0.2", "auth_required": False}
        
        with patch("httpx.AsyncClient") as MockClient:
            mock_instance = AsyncMock()
            mock_response = MagicMock()
            mock_response.status_code = 200
            mock_response.json.return_value = mock_card
            mock_instance.get = AsyncMock(return_value=mock_response)
            mock_instance.__aenter__ = AsyncMock(return_value=mock_instance)
            mock_instance.__aexit__ = AsyncMock(return_value=None)
            MockClient.return_value = mock_instance
            
            client = A2AClient()
            card = await client.discover_agent("http://test:8005")
            assert card.name == "Test"

    @pytest.mark.asyncio
    async def test_poll_until_complete(self):
        from benny.a2a.client import A2AClient
        
        client = A2AClient()
        
        task_data = {
            "id": "test-123",
            "status": "completed",
            "messages": [{"role": "agent", "parts": [{"type": "text", "content": "Done"}], "timestamp": "2026-01-01"}],
            "artifacts": [],
            "metadata": {},
            "created_at": "2026-01-01",
            "updated_at": "2026-01-01",
        }
        
        with patch.object(client, 'get_task_status', new_callable=AsyncMock) as mock_status:
            mock_status.return_value = A2ATask(**task_data)
            result = await client.poll_until_complete("http://test:8005", "test-123")
            assert result.status == TaskState.COMPLETED
