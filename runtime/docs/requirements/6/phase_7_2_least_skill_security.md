# Phase 7.2 — MCP Skill Segregation & Least Skills Security

## 1. Objective
Enforce the "Least Skills" principle. Each agent execution must be bounded by a **Permission Manifest** that restricts tool access to the absolute minimum required for the specific task.

## 2. Architectural Changes

### 2.1 Capability-Based Dispatch (`benny/governance/permission_manifest.py`)
- **Scoped Manifests**: Allow the creation of high-ephemeral manifests that only live for the duration of a single `TaskItem` execution.
- **Skill-to-Tool Mapping**: Explicitly link `assigned_skills` (from the Planner) to allowed MCP tool call patterns.

### 2.2 Executor Enforcement (`benny/graph/swarm.py`)
- **Pre-Execution Check**: The `executor_node` must validate its `assigned_skills` against the `PermissionManifest` before calling any tool.
- **Deny-by-Default REPL**: If the agent attempts a tool call not in its manifest, the system must intercept and log a `SECURITY_PERMISSION_VIOLATION`.

## 3. Implementation Details

### [MODIFY] [benny/governance/permission_manifest.py](file:///C:/Users/nsdha/OneDrive/code/benny/benny/governance/permission_manifest.py)
```python
def create_ephemeral_manifest(task_id: str, allowed_tools: List[str]) -> PermissionManifest:
    """Creates a temporary manifest for a specific task."""
    return PermissionManifest(
        skill_id=f"task_{task_id}",
        declared_capabilities=[f"tool:{t}" for t in allowed_tools],
        # Restrict to workspace only
        allowed_path_patterns=["workspace/**"],
        network_access=False 
    )
```

### [MODIFY] [benny/graph/swarm.py](file:///C:/Users/nsdha/OneDrive/code/benny/benny/graph/swarm.py)
```python
async def executor_node(state: Dict[str, Any]) -> Dict[str, Any]:
    # ... setup task ...
    
    # NEW: Secure tool binding
    allowed_skills = task.get("assigned_skills", [])
    manifest = create_ephemeral_manifest(task_id, allowed_skills)
    register_manifest(manifest) # Register temporary manifest
    
    # Proceed with execution...
```

## 4. Acceptance Criteria (BDD)
- **Scenario**: Agent attempts unauthorized tool use.
  - **Given** a task is assigned only the `read_document` skill.
  - **When** the agent attempts to call the `write_file` tool.
  - **Then** the execution must be blocked.
  - **And** a `SECURITY_PERMISSION_VIOLATION` event must be emitted with SHA-256 integrity.

## 5. Test Plan (TDD)
- `tests/test_skill_segregation.py`:
    - Define a task with restricted skills.
    - Attempt a "drifted" tool call in a mocked LLM response.
    - Assert that the `PermissionManifest` interceptor blocks the call.
    - Assert that the audit log records the violation.
