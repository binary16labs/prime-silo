"""
A2A Client — Delegates tasks to external A2A-compatible agents.

Usage:
    client = A2AClient()
    card = await client.discover_agent("http://remote-agent:8005")
    task = await client.send_task("http://remote-agent:8005", "Analyze this document...")
    result = await client.poll_until_complete("http://remote-agent:8005", task.id)
"""

from __future__ import annotations

import logging
import asyncio
from typing import Optional, AsyncIterator

import httpx

from .models import AgentCard, A2ATask, JsonRpcRequest, JsonRpcResponse, TaskState

logger = logging.getLogger(__name__)

DEFAULT_TIMEOUT = 300.0  # 5 minutes
POLL_INTERVAL = 2.0  # seconds


class A2AClientError(Exception):
    """Raised when an A2A client operation fails."""
    pass


class A2AClient:
    """
    Client for interacting with remote A2A-compatible agents.
    """
    
    def __init__(self, api_key: Optional[str] = None, timeout: float = DEFAULT_TIMEOUT):
        self.api_key = api_key
        self.timeout = timeout
    
    def _headers(self) -> dict:
        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["X-Benny-API-Key"] = self.api_key
        return headers
    
    async def discover_agent(self, agent_url: str) -> AgentCard:
        """
        Fetch a remote agent's Agent Card for capability discovery.
        
        Tries: /.well-known/agent.json first, then /a2a/agent-card
        
        Args:
            agent_url: Base URL of the remote agent (e.g., "http://remote:8005")
        
        Returns:
            AgentCard with the agent's capabilities
        
        Raises:
            A2AClientError: If discovery fails
        """
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            # Try well-known path first
            for path in ["/.well-known/agent.json", "/a2a/agent-card"]:
                try:
                    response = await client.get(
                        f"{agent_url.rstrip('/')}{path}",
                        headers=self._headers()
                    )
                    if response.status_code == 200:
                        return AgentCard(**response.json())
                except Exception:
                    continue
            
            raise A2AClientError(f"Could not discover agent at {agent_url}")
    
    async def send_task(
        self,
        agent_url: str,
        message: str,
        workspace: str = "default",
        model: Optional[str] = None,
    ) -> A2ATask:
        """
        Send a task to a remote A2A agent.
        
        Args:
            agent_url: Base URL of the target agent
            message: Task description / user message
            workspace: Workspace context
            model: Optional model override
        
        Returns:
            A2ATask with initial status (usually SUBMITTED or WORKING)
        """
        request = JsonRpcRequest(
            method="tasks/send",
            params={
                "message": message,
                "workspace": workspace,
                **({"model": model} if model else {}),
            }
        )
        
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            try:
                response = await client.post(
                    f"{agent_url.rstrip('/')}/a2a/tasks/send",
                    json=request.model_dump(),
                    headers=self._headers(),
                )
                
                if response.status_code != 200:
                    raise A2AClientError(f"Task send failed: {response.status_code} {response.text}")
                
                rpc_response = JsonRpcResponse(**response.json())
                
                if rpc_response.error:
                    raise A2AClientError(f"RPC error: {rpc_response.error}")
                
                return A2ATask(**rpc_response.result)
                
            except httpx.RequestError as e:
                raise A2AClientError(f"Connection failed: {str(e)}")
    
    async def get_task_status(self, agent_url: str, task_id: str) -> A2ATask:
        """
        Check the current status of a task.
        
        Args:
            agent_url: Base URL of the agent handling the task
            task_id: ID of the task to check
        
        Returns:
            Updated A2ATask
        """
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            response = await client.get(
                f"{agent_url.rstrip('/')}/a2a/tasks/{task_id}",
                headers=self._headers(),
            )
            
            if response.status_code == 404:
                raise A2AClientError(f"Task not found: {task_id}")
            if response.status_code != 200:
                raise A2AClientError(f"Status check failed: {response.status_code}")
            
            return A2ATask(**response.json())
    
    async def poll_until_complete(
        self,
        agent_url: str,
        task_id: str,
        poll_interval: float = POLL_INTERVAL,
        max_wait: float = 600.0,
    ) -> A2ATask:
        """
        Poll a task until it reaches a terminal state.
        
        Terminal states: COMPLETED, FAILED, CANCELED
        
        Args:
            agent_url: Base URL of the agent
            task_id: Task to poll
            poll_interval: Seconds between poll attempts
            max_wait: Maximum total wait time in seconds
        
        Returns:
            Final A2ATask state
        
        Raises:
            A2AClientError: If max_wait is exceeded
        """
        elapsed = 0.0
        while elapsed < max_wait:
            task = await self.get_task_status(agent_url, task_id)
            
            if task.status in (TaskState.COMPLETED, TaskState.FAILED, TaskState.CANCELED):
                return task
            
            await asyncio.sleep(poll_interval)
            elapsed += poll_interval
        
        raise A2AClientError(f"Task {task_id} did not complete within {max_wait}s")
    
    async def cancel_task(self, agent_url: str, task_id: str) -> dict:
        """Cancel a running task."""
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            response = await client.post(
                f"{agent_url.rstrip('/')}/a2a/tasks/{task_id}/cancel",
                headers=self._headers(),
            )
            return response.json()
