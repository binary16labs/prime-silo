# Execution Failure Diagnosis - Architecture Pivot Workflow

**Date**: 2026-04-11  
**Execution ID (Benny)**: `run-3aea04b9`  
**UI Reference ID**: `f809cedf-67f5-4e49-a646-97c12ca1d9d0`  
**Workspace**: test4  
**Executed**: 2026-04-11T10:11:53

---

## Executive Summary

The "architecture pivot" workflow failed during **initialization phase**, before any nodes could execute. The failure was **NOT captured by the governance audit system**, resulting in an empty failure report despite the task being marked as failed.

**Failure Duration**: ~200ms (immediate failure)  
**Root Cause**: Unknown - Error occurred outside governance event recording boundary

---

## Execution Timeline

| Timestamp | Event | Status |
|-----------|-------|--------|
| 10:11:53.140906 | Task created | running |
| 10:11:53.145473 | LINEAGE_START_WORKFLOW emitted | ✓ Recorded |
| 10:11:53.330058 | Task marked FAILED | ✗ No error details |
| **~200ms total** | **Initialization error** | **Silent failure** |

---

## Symptoms

### 1. Empty Error Message ✗
```json
{
  "task_id": "run-3aea04b9",
  "type": "studio_workflow",
  "status": "failed",
  "message": "",  // ← EMPTY = No error captured
  "aer_log": []   // ← No Agent Execution Records
}
```

### 2. No Governance Failure Events ✗
```
Governance Report for run-3aea04b9:
- Status: UNKNOWN
- Total Events: 2 (only LINEAGE_START_WORKFLOW events)
- Failures: 0
- First Error: null
```

### 3. Zero Node Execution ✗
- No nodes started (would have AER logs if any executed)
- Error occurred before node execution loop
- Suggests initialization or topological sort failure

---

## Root Cause Analysis

### Possible Causes (in priority order)

#### 1. **Invalid Node Graph / Circular Dependency** (Most Likely)
The workflow contains nodes that form a cycle or invalid references:

```
Symptoms:
- topological_sort() would fail immediately
- Error caught before workflow starts
- Both failed executions (run-61fa6ccb and run-3aea04b9) show identical pattern

Detection:
- Node edges reference non-existent nodes
- Multiple nodes with same ID
- Circular references: A→B→C→A
```

#### 2. **Missing Required Node Configuration**
One or more nodes missing critical config fields:

```
Symptoms:
- Node validation fails during initialization checkpoint
- Likely between LINEAGE_START and task failure
- Could be LLM model, data source, or required parameters

Example failures:
- LLM node without model specified
- Data node without collection/index name
- Tool node without tool definition
```

#### 3. **Missing Workspace Dependencies**
Test4 workspace lacks required resources:

```
Symptoms:
- ChromaDB collection missing ("knowledge" not found)
- LLM model not available (default_model: null in manifest!)
- API keys or credentials not configured

Evidence:
manifest.yaml shows:
  default_model: null  ← ⚠️ NO DEFAULT MODEL CONFIGURED!
  embedding_provider: local
```

#### 4. **Initialization Exception Not Emitted**
Code issue: Exception occurs outside governance recording boundary:

```python
# Current flow (issue):
try:
    sorted_nodes = topological_sort(...)  # ✓ Catches here
    task_manager.create_task(...)         # But if this fails...
    asyncio.create_task(_run_workflow_background(...))
except Exception as e:
    raise HTTPException(...)  # ✓ Caught here
    # ✗ But uncaught exceptions in callback run silently!
```

---

## Diagnostic Steps

### Step 1: Check Node Graph Validity
```bash
# Verify no cycles in the workflow
# Check node IDs are unique
# Verify edge source/target IDs exist in nodes list

# Raw workflow definition (need to get from UI database or memory)
```

### Step 2: Verify Workspace Configuration
```bash
# Check test4 manifest
cat workspace/test4/manifest.yaml

# CRITICAL ISSUE FOUND:
default_model: null  # ← This must be set!
```

### Step 3: Verify Dependencies
```bash
# Test ChromaDB connectivity
python3 -c "
from chromadb.config import Settings
from chromadb import Client
client = Client(Settings(chroma_db_impl='duckdb', persist_directory='workspace/test4/chromadb'))
print(client.list_collections())
"

# List available models
curl http://localhost:8005/api/models
```

### Step 4: Enable Debug Logging
```python
# In studio_executor.py, add detailed logging:
logging.basicConfig(level=logging.DEBUG)
logging.debug(f"Nodes: {[n.id for n in request.nodes]}")
logging.debug(f"Edges: {[(e.source, e.target) for e in request.edges]}")
logging.debug(f"Sorted nodes: {sorted_nodes}")
```

### Step 5: Check Server Logs
```bash
# Look for stderr output from Benny API server
# Check for Python stack traces around 2026-04-11 10:11:53

# Windows event logs may have application crashes
Get-EventLog -LogName Application -After (Get-Date "2026-04-11 10:11:00") | Select-Object TimeGenerated, Message
```

---

## Fixes

### Fix #1: Set Default Model (CRITICAL)
```yaml
# Edit workspace/test4/manifest.yaml
default_model: "lm-studio"  # Or your configured model
# OR
default_model: "openai"
# OR
default_model: "claude"
```

### Fix #2: Add Initialization Error Handler (CODE FIX)
Currently, errors during initialization are not emitted to governance. Update [studio_executor.py](benny/api/studio_executor.py#L660):

```python
@router.post("/workflows/execute")
async def execute_studio_workflow(request: StudioExecuteRequest):
    run_id = f"run-{uuid.uuid4().hex[:8]}"
    
    try:
        sorted_nodes = topological_sort(request.nodes, request.edges)
    except Exception as e:
        logging.error(f"Topological sort failed: {str(e)}", exc_info=True)
        # ✓ EMIT FAILURE EVENT
        emit_execution_failure(
            run_id,
            request.workspace,
            ExecutionPhase.INITIALIZATION,
            e,
            context={"error_stage": "topological_sort", "nodes_count": len(request.nodes)}
        )
        task_manager.create_task(request.workspace, "studio_workflow", task_id=run_id)
        task_manager.update_task(run_id, status="failed", message=f"Graph validation failed: {str(e)[:200]}")
        raise HTTPException(400, f"Invalid workflow graph: {str(e)}")
```

### Fix #3: Verify Node Graph Before Execution
Add pre-flight validation:

```python
def validate_workflow_graph(nodes: List[StudioNode], edges: List[StudioEdge]) -> Tuple[bool, str]:
    """Validate workflow graph before execution"""
    node_ids = {n.id for n in nodes}
    
    # Check for missing nodes in edges
    for edge in edges:
        if edge.source not in node_ids:
            return False, f"Edge references missing source node: {edge.source}"
        if edge.target not in node_ids:
            return False, f"Edge references missing target node: {edge.target}"
    
    # Check for duplicate node IDs
    if len(node_ids) != len(nodes):
        return False, "Duplicate node IDs detected"
    
    # Check for isolated nodes (optional warning)
    connected = set()
    for edge in edges:
        connected.add(edge.source)
        connected.add(edge.target)
    
    isolated = node_ids - connected
    if isolated:
        logging.warning(f"Isolated nodes will not execute: {isolated}")
    
    return True, ""
```

---

## How to Re-run Successfully

1. **Fix the workspace configuration**:
   ```yaml
   default_model: "lm-studio"  # Or your model
   ```

2. **Validate the workflow graph**:
   - Check node IDs are unique
   - Verify all edge references exist
   - Ensure no circular dependencies

3. **Re-execute**:
   - Click "Run" in Studio UI
   - Compare new run_id with previous `run-3aea04b9`
   - Monitor execution report for success

4. **If still fails**:
   - Check server logs for detailed error
   - Enable DEBUG logging in studio_executor.py
   - Verify node configurations individually

---

## Files Affected

- [studio_executor.py](benny/api/studio_executor.py) — Exception handling for initialization
- [manifest.yaml](workspace/test4/manifest.yaml) — Default model must be set
- [execution_audit.py](benny/governance/execution_audit.py) — Ensure all errors are emitted

---

## Prevention

### Immediate (Code Changes)
- [ ] Add initialization error event emission
- [ ] Add pre-flight graph validation
- [ ] Log detailed node/edge info on failure

### Short-term (Configuration)
- [ ] Set default_model in test4 manifest
- [ ] Document required configuration for Studio workflows
- [ ] Add validation endpoint: `POST /api/workflows/validate`

### Long-term (System)
- [ ] Add workflow schema validation in Studio UI
- [ ] Show validation errors before execution
- [ ] Enhanced error reporting with traces
- [ ] Health checks for workspace dependencies

---

## Summary Table

| Item | Status | Evidence |
|------|--------|----------|
| **Error Recorded** | ✗ NO | Governance report shows 0 failures |
| **Node Executed** | ✗ NO | AER log is empty |
| **Duration** | ~200ms | Immediate failure suggests init error |
| **Root Cause** | UNKNOWN | No error details captured |
| **Most Likely Cause** | Graph validation OR missing model | manifes.yaml default_model: null |
| **Code Issue** | YES | Exception occurs outside audit boundary |
| **Fix Available** | YES | See Fixes section above |

---

**Next Action**: Run diagnostic steps above and provide error logs for precise root cause identification.
