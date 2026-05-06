"""
Benny Governance - OpenLineage integration for data lineage tracking
Emits lineage events to Marquez for full auditability
"""

import os
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Optional, Dict, Any, List
import logging
import json
import httpx
from .audit import emit_governance_event

from openlineage.client import OpenLineageClient
from openlineage.client.run import Run, RunEvent, RunState, Job, InputDataset, OutputDataset
from openlineage.client.facet import (
    BaseFacet,
    SqlJobFacet,
    DocumentationJobFacet,
    DocumentationDatasetFacet,
    SourceCodeLocationJobFacet,
    ParentRunFacet,
)
import attr

logger = logging.getLogger(__name__)


# =============================================================================
# CONFIGURATION
# =============================================================================

MARQUEZ_URL = os.getenv("MARQUEZ_URL", "http://localhost:5000")
NAMESPACE = os.getenv("LINEAGE_NAMESPACE", "benny")
PRODUCER = "https://github.com/benny/platform"


# =============================================================================
# CUSTOM FACETS
# =============================================================================

# Custom facets must inherit from BaseFacet and include _producer and _schemaURL
# We use standard dataclasses with field naming that matches the OpenLineage spec

@dataclass
class LLMCallFacet(BaseFacet):
    model: str
    provider: str
    temperature: float
    max_tokens: int
    prompt_tokens: Optional[int] = None
    completion_tokens: Optional[int] = None
    total_tokens: Optional[int] = None
    _producer: str = PRODUCER
    _schemaURL: Optional[str] = None


@dataclass
class WorkflowExecutionFacet(BaseFacet):
    workflow_id: str
    workspace: str
    nodes_executed: List[str]
    execution_time_ms: int
    status: str
    _producer: str = PRODUCER
    _schemaURL: Optional[str] = None


@dataclass
class ToolExecutionFacet(BaseFacet):
    tool_name: str
    tool_args: Dict[str, Any]
    success: bool
    error_message: Optional[str] = None
    _producer: str = PRODUCER
    _schemaURL: Optional[str] = None


@dataclass
class AgentExecutionRecordFacet(BaseFacet):
    intent: str
    observation: str
    inference: str = ""
    plan: str = ""
    run_id: Optional[str] = None
    _producer: str = PRODUCER
    _schemaURL: Optional[str] = None


@dataclass
class PolicyBreachFacet(BaseFacet):
    rule: str
    description: str
    content_snippet: str
    node_id: str
    _producer: str = PRODUCER
    _schemaURL: Optional[str] = None


@dataclass
class BennyContextFacet(BaseFacet):
    """Facet to link OpenLineage runs back to Benny's internal IDs"""
    benny_run_id: str
    workspace: str
    _producer: str = PRODUCER
    _schemaURL: Optional[str] = None


# =============================================================================
# LINEAGE CLIENT
# =============================================================================

class BennyLineageClient:
    """
    OpenLineage client wrapper for Benny platform.
    Tracks workflow executions, LLM calls, and tool invocations.
    """
    
    def __init__(self, marquez_url: str = MARQUEZ_URL, namespace: str = NAMESPACE):
        self.namespace = namespace
        self.marquez_url = marquez_url
        self._client: Optional[OpenLineageClient] = None
        self._runs: Dict[str, Run] = {}
        self._run_id_map: Dict[str, str] = {} # Benny ID -> OpenLineage UUID
    
    @property
    def client(self) -> OpenLineageClient:
        """Lazy-initialize OpenLineage client"""
        if self._client is None:
            self._client = OpenLineageClient(url=self.marquez_url)
        return self._client
    
    def _get_or_create_uuid(self, benny_id: Optional[str]) -> str:
        """Ensure we have a valid UUID for OpenLineage, mapping from Benny ID if needed"""
        if not benny_id:
            return str(uuid.uuid4())
        
        # Check if already a valid UUID
        try:
            uuid.UUID(benny_id)
            return benny_id
        except ValueError:
            # Not a UUID, check map or generate new
            if benny_id not in self._run_id_map:
                self._run_id_map[benny_id] = str(uuid.uuid4())
                logger.info("Mapped Benny ID '%s' to OpenLineage UUID '%s'", benny_id, self._run_id_map[benny_id])
            return self._run_id_map[benny_id]

    def _create_run(self, benny_id: Optional[str] = None, facets: Optional[Dict[str, BaseFacet]] = None) -> Run:
        """Create a new run with valid UUID and optional facets"""
        run_id = self._get_or_create_uuid(benny_id)
        
        actual_facets = facets or {}
        if benny_id and "benny_context" not in actual_facets:
            actual_facets["benny_context"] = BennyContextFacet(
                benny_run_id=benny_id,
                workspace="default" # Ideally passed, but defaulting for now
            )
            
        return Run(runId=run_id, facets=actual_facets)
    
    def _create_job(self, job_name: str, facets: Optional[Dict[str, BaseFacet]] = None) -> Job:
        """Create a job with the given name and facets"""
        return Job(
            namespace=self.namespace,
            name=job_name,
            facets=facets or {}
        )
    
    # -------------------------------------------------------------------------
    # Workflow Events
    # -------------------------------------------------------------------------
    
    def start_workflow(
        self,
        workflow_id: str,
        workflow_name: str,
        workspace: str,
        inputs: Optional[List[str]] = None,
        outputs: Optional[List[str]] = None,
        metadata: Optional[Dict[str, Any]] = None
    ) -> str:
        """Emit START event for workflow execution"""
        # workflow_id here is Benny's internal execution ID (e.g. run-xxxx)
        
        facets = {
            "benny_context": BennyContextFacet(
                benny_run_id=workflow_id,
                workspace=workspace
            )
        }
        
        run = self._create_run(workflow_id, facets=facets)
        self._runs[workflow_id] = run
        
        job = self._create_job(
            job_name=f"workflow.{workflow_name}",
            facets={
                "documentation": DocumentationJobFacet(
                    description=f"Benny workflow: {workflow_name} in workspace {workspace}"
                )
            }
        )
        
        input_datasets = [self._create_dataset(name, workspace) for name in (inputs or [])]
        output_datasets = [self._create_dataset(name, workspace) for name in (outputs or [])]
        
        try:
            event = RunEvent(
                eventType=RunState.START,
                eventTime=datetime.now(timezone.utc).isoformat(),
                run=run,
                producer=PRODUCER,
                job=job,
                inputs=input_datasets,
                outputs=output_datasets
            )
            self.client.emit(event)
            # Local Audit Log
            emit_governance_event(
                event_type="LINEAGE_START_WORKFLOW",
                data=attr.asdict(event),
                workspace_id=workspace
            )
        except Exception as e:
            logger.warning("Failed to emit lineage start_workflow event: %s", e)
        return workflow_id
    
    def complete_workflow(
        self,
        workflow_id: str,
        workflow_name: str,
        workspace: str,
        nodes_executed: List[str],
        execution_time_ms: int,
        outputs: Optional[List[str]] = None,
        status: str = "completed"
    ) -> None:
        """Emit COMPLETE event for workflow execution"""
        # Lookup the Run object (which contains the valid OpenLineage UUID)
        run = self._runs.get(workflow_id)
        if not run:
            # Fallback creation if not tracked (unlikely)
            run = self._create_run(workflow_id)
        
        job = self._create_job(job_name=f"workflow.{workflow_name}")
        
        # Merge facets
        facets = {
            "workflow_execution": WorkflowExecutionFacet(
                workflow_id=workflow_id,
                workspace=workspace,
                nodes_executed=nodes_executed,
                execution_time_ms=execution_time_ms,
                status=status
            )
        }
        if workflow_id in self._run_id_map:
             facets["benny_context"] = BennyContextFacet(
                benny_run_id=workflow_id,
                workspace=workspace
            )

        run = Run(
            runId=run.runId,
            facets=facets
        )
        
        try:
            event = RunEvent(
                eventType=RunState.COMPLETE,
                eventTime=datetime.now(timezone.utc).isoformat(),
                run=run,
                producer=PRODUCER,
                job=job,
                inputs=[],
                outputs=[self._create_dataset(name, workspace) for name in (outputs or [])]
            )
            self.client.emit(event)
            # Local Audit Log
            emit_governance_event(
                event_type="LINEAGE_COMPLETE_WORKFLOW",
                data=attr.asdict(event),
                workspace_id=workspace
            )
        except Exception as e:
            logger.warning("Failed to emit lineage complete_workflow event: %s", e)
        
        self._runs.pop(workflow_id, None)
    
    def fail_workflow(
        self,
        workflow_id: str,
        workflow_name: str,
        workspace: str,
        error_message: str
    ) -> None:
        """Emit FAIL event for workflow execution"""
        run = self._runs.get(workflow_id)
        if not run:
            run = self._create_run(workflow_id)
        
        job = self._create_job(job_name=f"workflow.{workflow_name}")
        
        try:
            event = RunEvent(
                eventType=RunState.FAIL,
                eventTime=datetime.now(timezone.utc).isoformat(),
                run=run,
                producer=PRODUCER,
                job=job,
                inputs=[],
                outputs=[]
            )
            self.client.emit(event)
            # Local Audit Log
            emit_governance_event(
                event_type="LINEAGE_FAIL_WORKFLOW",
                data=attr.asdict(event),
                workspace_id=workspace
            )
        except Exception as e:
            logger.warning("Failed to emit lineage fail_workflow event: %s", e)
        self._runs.pop(workflow_id, None)
    
    def _create_dataset(self, name: str, workspace: str, description: str = "") -> InputDataset:
        """Create a dataset with a human-readable identifier and optional description."""
        # Use workspace-prefixed name for clear ID, but provide label via DocumentationDatasetFacet
        return InputDataset(
            namespace=self.namespace,
            name=f"{workspace}:{name}",
            facets={
                "documentation": DocumentationDatasetFacet(
                    description=description or f"Benny data object: {name}"
                )
            }
        )

    # -------------------------------------------------------------------------
    # LLM Call Events
    # -------------------------------------------------------------------------
    
    def emit_llm_call(
        self,
        parent_run_id: str,
        model: str,
        provider: str,
        temperature: float = 0.7,
        max_tokens: int = 2000,
        usage: Optional[Dict[str, int]] = None,
        parent_job_name: str = "parent_workflow"
    ) -> str:
        """Emit event for LLM API call, linked to a parent workflow run."""
        job = self._create_job(job_name=f"llm.{provider}.{model.replace('/', '_')}")
        
        # Resolve OpenLineage UUID for the parent
        parent_uuid = self._get_or_create_uuid(parent_run_id)

        # Link to parent for nested visualization in Marquez
        facets = {
            "llm_call": LLMCallFacet(
                model=model,
                provider=provider,
                temperature=temperature,
                max_tokens=max_tokens,
                prompt_tokens=usage.get("prompt_tokens") if usage else None,
                completion_tokens=usage.get("completion_tokens") if usage else None,
                total_tokens=usage.get("total_tokens") if usage else None
            ),
            "parent": ParentRunFacet(
                run={"runId": parent_uuid},
                job={"namespace": self.namespace, "name": parent_job_name}
            )
        }
        
        run = self._create_run(facets=facets)
        
        try:
            event = RunEvent(
                eventType=RunState.COMPLETE,
                eventTime=datetime.now(timezone.utc).isoformat(),
                run=run,
                producer=PRODUCER,
                job=job,
                inputs=[],
                outputs=[]
            )
            self.client.emit(event)
            # Local Audit Log
            emit_governance_event(
                event_type="LINEAGE_LLM_CALL",
                data=attr.asdict(event),
                workspace_id="global"  # LLM calls are often cross-workspace, or we can use the parent run ID
            )
        except Exception as e:
            logger.warning("Failed to emit LLM call lineage: %s", e)
        return run.runId
    
    # -------------------------------------------------------------------------
    # Tool Execution Events
    # -------------------------------------------------------------------------
    
    def emit_tool_execution(
        self,
        parent_run_id: str,
        tool_name: str,
        tool_args: Dict[str, Any],
        success: bool,
        error_message: Optional[str] = None,
        parent_job_name: str = "parent_workflow"
    ) -> str:
        """Emit event for tool execution, nested within parent run."""
        job = self._create_job(job_name=f"tool.{tool_name}")
        
        parent_uuid = self._get_or_create_uuid(parent_run_id)

        facets = {
            "tool_execution": ToolExecutionFacet(
                tool_name=tool_name,
                tool_args=tool_args,
                success=success,
                error_message=error_message
            ),
            "parent": ParentRunFacet(
                run={"runId": parent_uuid},
                job={"namespace": self.namespace, "name": parent_job_name}
            )
        }
        
        run = self._create_run(facets=facets)
        
        try:
            event = RunEvent(
                eventType=RunState.COMPLETE if success else RunState.FAIL,
                eventTime=datetime.now(timezone.utc).isoformat(),
                run=run,
                producer=PRODUCER,
                job=job,
                inputs=[],
                outputs=[]
            )
            self.client.emit(event)
            # Local Audit Log
            emit_governance_event(
                event_type="LINEAGE_TOOL_EXECUTION",
                data=attr.asdict(event),
                workspace_id="global"
            )
        except Exception as e:
            logger.warning("Failed to emit tool execution lineage: %s", e)
        return run.runId

    # -------------------------------------------------------------------------
    # Dataset Transformation Events
    # -------------------------------------------------------------------------
    
    def emit_file_conversion(
        self,
        input_path: str,
        output_path: str,
        workspace: str,
        job_name: str = "pdf_to_markdown"
    ) -> str:
        """Emit event for a file format transformation / ETL step"""
        run = self._create_run()
        
        job = self._create_job(job_name=f"etl.{job_name}_{workspace}")
        
        # Define the input and output datasets
        input_dataset = InputDataset(
            namespace=self.namespace,
            name=input_path
        )
        
        output_dataset = OutputDataset(
            namespace=self.namespace,
            name=output_path
        )
        
        if hasattr(run, "facets"):
            run.facets["parent"] = ParentRunFacet(
                run={"runId": str(uuid.uuid4())}, # Need a way to pass parent id to conversion if possible
                job={"namespace": self.namespace, "name": "automated_ingest"}
            )
        
        try:
            event = RunEvent(
                eventType=RunState.COMPLETE,
                eventTime=datetime.now(timezone.utc).isoformat(),
                run=run,
                producer=PRODUCER,
                job=job,
                inputs=[input_dataset],
                outputs=[output_dataset]
            )
            self.client.emit(event)
            # Local Audit Log
            emit_governance_event(
                event_type="LINEAGE_FILE_CONVERSION",
                data=attr.asdict(event),
                workspace_id=workspace
            )
        except Exception as e:
            logger.warning("Failed to emit file conversion lineage: %s", e)
        return run.runId

    # -------------------------------------------------------------------------
    # Agent Reasoning (AER) Events
    # -------------------------------------------------------------------------

    def emit_aer(
        self,
        run_id: str,
        job_name: str,
        workspace: str,
        intent: str,
        observation: str,
        inference: str = "",
        plan: str = ""
    ) -> None:
        """Emit a RUNNING event with the Agent Execution Record facet."""
        run = self._runs.get(run_id)
        if not run:
            run = self._create_run(run_id)
            
        ol_run_id = run.runId
        job = self._create_job(job_name=job_name)
        
        event_run = Run(
            runId=ol_run_id,
            facets={
                "agent_execution_record": AgentExecutionRecordFacet(
                    intent=intent,
                    observation=observation,
                    inference=inference,
                    plan=plan,
                    run_id=run_id
                ),
                "parent": ParentRunFacet(
                    run={"runId": ol_run_id}, # Link reasoning back to the main synthesis workflow
                    job={"namespace": self.namespace, "name": job_name}
                )
            }
        )
        
        try:
            event = RunEvent(
                eventType=RunState.RUNNING,
                eventTime=datetime.now(timezone.utc).isoformat(),
                run=event_run,
                producer=PRODUCER,
                job=job,
                inputs=[],
                outputs=[]
            )
            self.client.emit(event)
            # Local Audit Log
            emit_governance_event(
                event_type="LINEAGE_AER",
                data=attr.asdict(event),
                workspace_id=workspace
            )
        except Exception as e:
            logger.warning("Failed to emit AER lineage event: %s", e)

    def emit_policy_breach(
        self,
        run_id: str,
        node_id: str,
        rule: str,
        description: str,
        content_snippet: str,
        workspace: str = "default"
    ) -> None:
        """Emit a RUNNING event with a PolicyBreachFacet to signal HITL intervention."""
        run = self._runs.get(run_id)
        if not run:
            run = self._create_run(run_id)
            
        ol_run_id = run.runId
        job = self._create_job(job_name="studio_workflow_intervention")
        
        event_run = Run(
            runId=ol_run_id,
            facets={
                "policy_breach": PolicyBreachFacet(
                    rule=rule,
                    description=description,
                    content_snippet=content_snippet,
                    node_id=node_id
                )
            }
        )
        
        try:
            event = RunEvent(
                eventType=RunState.OTHER, # Use OTHER for intervention pauses
                eventTime=datetime.now(timezone.utc).isoformat(),
                run=event_run,
                producer=PRODUCER,
                job=job,
                inputs=[],
                outputs=[]
            )
            self.client.emit(event)
            # Local Audit Log
            emit_governance_event(
                event_type="POLICY_BREACH_INTERVENTION",
                data=attr.asdict(event),
                workspace_id=workspace
            )
        except Exception as e:
            logger.warning("Failed to emit policy breach lineage: %s", e)


# =============================================================================
# GLOBAL CLIENT INSTANCE
# =============================================================================

_lineage_client: Optional[BennyLineageClient] = None


def get_lineage_client() -> BennyLineageClient:
    """Get or create the global lineage client"""
    global _lineage_client
    if _lineage_client is None:
        _lineage_client = BennyLineageClient()
    return _lineage_client


# =============================================================================
# CONVENIENCE FUNCTIONS
# =============================================================================

def track_workflow_start(
    workflow_id: str,
    workflow_name: str,
    workspace: str,
    inputs: Optional[List[str]] = None,
    outputs: Optional[List[str]] = None
) -> str:
    """Track workflow start - convenience function"""
    return get_lineage_client().start_workflow(
        workflow_id, workflow_name, workspace, inputs=inputs, outputs=outputs
    )


def track_workflow_complete(
    workflow_id: str,
    workflow_name: str,
    workspace: str,
    nodes_executed: List[str],
    execution_time_ms: int,
    outputs: Optional[List[str]] = None,
    status: str = "completed"
) -> None:
    """Track workflow completion - convenience function"""
    get_lineage_client().complete_workflow(
        workflow_id, workflow_name, workspace, nodes_executed, execution_time_ms, outputs=outputs, status=status
    )


def track_workflow_fail(
    workflow_id: str,
    workflow_name: str,
    workspace: str,
    error_message: str
) -> None:
    """Track workflow failure - convenience function"""
    get_lineage_client().fail_workflow(
        workflow_id, workflow_name, workspace, error_message
    )


def track_llm_call(
    parent_run_id: str,
    model: str,
    provider: str,
    usage: Optional[Dict[str, int]] = None,
    parent_job_name: str = "parent_workflow"
) -> str:
    """Track LLM call - convenience function"""
    return get_lineage_client().emit_llm_call(
        parent_run_id, model, provider, usage=usage, parent_job_name=parent_job_name
    )


def track_tool_execution(
    parent_run_id: str,
    tool_name: str,
    tool_args: Dict[str, Any],
    success: bool,
    error_message: Optional[str] = None,
    parent_job_name: str = "parent_workflow"
) -> str:
    """Track tool execution - convenience function"""
    return get_lineage_client().emit_tool_execution(
        parent_run_id, tool_name, tool_args, success, error_message, parent_job_name=parent_job_name
    )


def track_file_conversion(
    input_path: str,
    output_path: str,
    workspace: str,
    job_name: str = "pdf_to_markdown"
) -> str:
    """Track a file format transformation - convenience function"""
    return get_lineage_client().emit_file_conversion(
        input_path, output_path, workspace, job_name
    )


def track_aer(
    run_id: str,
    job_name: str,
    workspace: str,
    intent: str,
    observation: str,
    inference: str = "",
    plan: str = ""
) -> None:
    """Track reasoning step - convenience function"""
    get_lineage_client().emit_aer(
        run_id, job_name, workspace, intent, observation, inference, plan
    )


def track_policy_breach(
    run_id: str,
    node_id: str,
    rule: str,
    description: str,
    content_snippet: str,
    workspace: str = "default"
) -> None:
    """Track policy breach and intervention - convenience function"""
    get_lineage_client().emit_policy_breach(
        run_id, node_id, rule, description, content_snippet, workspace
    )
