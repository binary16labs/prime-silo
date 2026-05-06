"""
A2A Protocol Data Models — JSON-RPC 2.0 compliant message types.
"""

from __future__ import annotations
from pydantic import BaseModel, Field
from typing import Optional, List, Dict, Any, Literal
from datetime import datetime
from enum import Enum
import uuid


# =============================================================================
# ENUMS
# =============================================================================

class TaskState(str, Enum):
    """Valid states for an A2A Task."""
    SUBMITTED = "submitted"
    WORKING = "working"
    INPUT_REQUIRED = "input-required"
    COMPLETED = "completed"
    CANCELED = "canceled"
    FAILED = "failed"


class PartType(str, Enum):
    """Content modalities for UX Parts."""
    TEXT = "text"
    JSON_DATA = "json"
    FILE = "file"
    IFRAME = "iframe"
    FORM = "form"


# =============================================================================
# UX PARTS — Modality Negotiation
# =============================================================================

class UXPart(BaseModel):
    """
    A single content part within a message.
    Agents negotiate format using these typed parts.
    """
    type: PartType
    content: str = ""                   # Text content or JSON string
    mime_type: Optional[str] = None     # e.g., "application/json", "text/html"
    uri: Optional[str] = None           # For file or iframe types
    metadata: Dict[str, Any] = Field(default_factory=dict)


# =============================================================================
# MESSAGES
# =============================================================================

class A2AMessage(BaseModel):
    """
    A single exchange turn within a task conversation.
    """
    role: Literal["user", "agent"]
    parts: List[UXPart]
    timestamp: str = Field(default_factory=lambda: datetime.utcnow().isoformat())
    metadata: Dict[str, Any] = Field(default_factory=dict)

    @classmethod
    def text(cls, role: Literal["user", "agent"], content: str) -> "A2AMessage":
        """Convenience method to create a simple text message."""
        return cls(role=role, parts=[UXPart(type=PartType.TEXT, content=content)])


# =============================================================================
# ARTIFACTS
# =============================================================================

class A2AArtifact(BaseModel):
    """
    An output artifact produced by an agent during task execution.
    """
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    name: str
    description: str = ""
    parts: List[UXPart]
    metadata: Dict[str, Any] = Field(default_factory=dict)


# =============================================================================
# TASKS
# =============================================================================

class A2ATask(BaseModel):
    """
    The fundamental unit of work in the A2A protocol.
    """
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    status: TaskState = TaskState.SUBMITTED
    messages: List[A2AMessage] = Field(default_factory=list)
    artifacts: List[A2AArtifact] = Field(default_factory=list)
    metadata: Dict[str, Any] = Field(default_factory=dict)
    created_at: str = Field(default_factory=lambda: datetime.utcnow().isoformat())
    updated_at: str = Field(default_factory=lambda: datetime.utcnow().isoformat())


# =============================================================================
# AGENT CARD — Capability Discovery
# =============================================================================

class AgentSkillCard(BaseModel):
    """A single skill advertised in the Agent Card."""
    id: str
    name: str
    description: str
    input_modes: List[str] = ["text"]     # Supported input modalities
    output_modes: List[str] = ["text"]    # Supported output modalities


class AgentCard(BaseModel):
    """
    Agent Card — the identity and capability manifest of an A2A agent.
    Served at /.well-known/agent.json
    """
    name: str
    description: str
    url: str                              # Base URL of this agent
    version: str = "1.0.0"
    protocol_version: str = "0.2"         # A2A spec version
    skills: List[AgentSkillCard] = Field(default_factory=list)
    auth_required: bool = False
    auth_type: Optional[str] = None       # "api_key", "oauth2", etc.
    supported_input_modes: List[str] = ["text", "json"]
    supported_output_modes: List[str] = ["text", "json"]
    metadata: Dict[str, Any] = Field(default_factory=dict)


# =============================================================================
# JSON-RPC 2.0 Wrappers
# =============================================================================

class JsonRpcRequest(BaseModel):
    """Standard JSON-RPC 2.0 request."""
    jsonrpc: str = "2.0"
    id: Optional[str] = Field(default_factory=lambda: str(uuid.uuid4()))
    method: str
    params: Dict[str, Any] = Field(default_factory=dict)


class JsonRpcResponse(BaseModel):
    """Standard JSON-RPC 2.0 response."""
    jsonrpc: str = "2.0"
    id: Optional[str] = None
    result: Optional[Any] = None
    error: Optional[Dict[str, Any]] = None
