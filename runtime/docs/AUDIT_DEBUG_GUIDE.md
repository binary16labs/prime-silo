# Enhanced Audit System for Debugging Workflow Failures

The Benny platform now includes a comprehensive audit system that captures detailed failure information for all workflow executions. This system provides multiple ways to investigate what went wrong during execution.

## Features

### 1. **Detailed Failure Logging**
- Full stack traces for exceptions
- Exception chains (cause → effect)
- Execution phase tracking (initialization, validation, execution, finalization)
- Node-specific error context

### 2. **Node-Level Execution Tracking**
- Node input/output capture
- Execution duration per node
- Node status progression (started, completed, failed)
- Error details with context

### 3. **Execution Checkpoints**
- Track execution progression through phases
- Capture state snapshots at key points
- Enable root cause analysis

### 4. **API Endpoints for Audit Retrieval**

#### **GET /api/governance/verify-audit/{execution_id}**
Enhanced endpoint that returns comprehensive audit trail.

**Query Parameters:**
- `workspace`: Workspace ID (default: "default")

**Response:**
```json
{
  "execution_id": "run-61fa6ccb",
  "status": "failed",
  "failures": [...],
  "node_states": [...],
  "checkpoints": [...],
  "summary": {
    "total_events": 25,
    "failure_count": 1,
    "node_count": 5,
    "first_failure": "2026-04-11T09:40:46.190427+00:00",
    "execution_phases": ["initialization", "execution", "finalization"]
  }
}
```

#### **GET /api/governance/execution/{execution_id}/failures**
Get all failures recorded for a specific execution.

```bash
curl "http://localhost:50060/api/governance/execution/run-61fa6ccb/failures?workspace=test4"
```

#### **GET /api/governance/execution/{execution_id}/nodes**
Get detailed node execution states with input/output data.

```bash
curl "http://localhost:50060/api/governance/execution/run-61fa6ccb/nodes?workspace=test4"
```

#### **GET /api/governance/execution/{execution_id}/report**
Get a human-readable text report of the execution failure.

```bash
curl "http://localhost:50060/api/governance/execution/run-61fa6ccb/report?workspace=test4"
```

## CLI Tool: audit_debug.py

The `scripts/audit_debug.py` tool provides command-line access to audit functionality.

### Installation

```bash
cd benny
python scripts/audit_debug.py --help
```

### Commands

#### 1. **summary** - Show execution audit summary
```bash
python scripts/audit_debug.py summary run-61fa6ccb -w test4
```

Output shows:
- Overall status
- Number of events, failures, and nodes
- Execution phases
- First error details

#### 2. **failures** - Show all failures
```bash
python scripts/audit_debug.py failures run-61fa6ccb -w test4
```

Output shows each failure with:
- Timestamp
- Execution phase
- Error type and message
- Stack trace (first 10 lines)

#### 3. **nodes** - Show node execution details
```bash
python scripts/audit_debug.py nodes run-61fa6ccb -w test4
```

Output shows:
- Completed nodes (with duration and output)
- Failed nodes (with error details)
- Other nodes

#### 4. **report** - Generate full report
```bash
python scripts/audit_debug.py report run-61fa6ccb -w test4 -o report.txt
```

Output includes full failure details, node information, and stack traces.

#### 5. **json** - Export full audit as JSON
```bash
python scripts/audit_debug.py json run-61fa6ccb -w test4 -o audit.json
```

Useful for programmatic processing or integration with other tools.

## Understanding Failure Information

### Execution Phases

When a failure occurs, the audit system records which phase it happened in:

- **`initialization`**: Failed during setup (e.g., invalid workflow config)
- **`validation`**: Failed during node validation
- **`execution`**: Failed during actual node execution (most common)
- **`finalization`**: Failed during cleanup

### Exception Chain

If there are multiple exceptions (one causing another), the audit system captures the full chain:

```
Chain:
  1. ValueError: Invalid node configuration
     └─ Caused by: KeyError: 'required_field'
```

### Error Context

Each failure includes execution context:
- Current node being executed
- Previous results from earlier nodes
- Input data to the failed node
- Relevant workspace settings

## Audit Log Locations

Audit logs are stored in the workspace filesystem:

```
workspace/
├── governance.log              # Global audit log
└── {workspace_id}/
    └── runs/
        ├── audit.log           # Workspace-specific audit
        └── artifacts/          # Large payloads stored separately
```

## Example: Debugging the Architect Pivot Failure

Given your recent failure with execution ID `run-61fa6ccb` in workspace `test4`:

### Step 1: Get quick overview
```bash
python scripts/audit_debug.py summary run-61fa6ccb -w test4
```

### Step 2: Examine failures
```bash
python scripts/audit_debug.py failures run-61fa6ccb -w test4
```

### Step 3: Check node details
```bash
python scripts/audit_debug.py nodes run-61fa6ccb -w test4
```

### Step 4: Generate detailed report
```bash
python scripts/audit_debug.py report run-61fa6ccb -w test4 -o failure_analysis.txt
cat failure_analysis.txt
```

Or fetch via API:
```bash
curl "http://localhost:50060/api/governance/execution/run-61fa6ccb/report?workspace=test4" | jq '.report' -r
```

## Using the API

### Query for failures
```bash
curl "http://localhost:50060/api/governance/execution/run-61fa6ccb/failures?workspace=test4" | jq
```

### Extract first error
```bash
curl "http://localhost:50060/api/governance/execution/run-61fa6ccb/failures?workspace=test4" \
  | jq '.failures[0].data.error'
```

### Get failed nodes
```bash
curl "http://localhost:50060/api/governance/execution/run-61fa6ccb/nodes?workspace=test4" \
  | jq '.nodes_by_status.failed'
```

## Audit Event Types

The system records various audit event types:

- **`EXECUTION_FAILURE`**: Full failure with stack trace and context
- **`NODE_EXECUTION_STATE`**: Node start/completion with I/O data
- **`EXECUTION_CHECKPOINT`**: State snapshots at key phases
- **`TASK_METADATA_UPDATE`**: Task status changes
- **`LINEAGE_START_WORKFLOW`**: Workflow initialization
- **`LINEAGE_FILE_CONVERSION`**: Data transformation events

## Reducing API Costs

With detailed audit trails, you can now:

1. **Quickly identify failures** without running the workflow again
2. **Understand root causes** from stack traces and context
3. **Detect patterns** in recurring failures
4. **Reduce LLM API calls** by not needing me to help debug via trial-and-error

The system captures everything needed for diagnosis, so you can focus debugging on the real issues.

## Best Practices

1. **Check audit immediately after failure** - Events are flushed to disk in real-time
2. **Use JSON export for deep analysis** - `audit_debug.py json` outputs all events
3. **Save reports for comparison** - Compare multiple failures to identify patterns
4. **Check execution phases** - Knowing where failure occurred helps narrow down cause
5. **Look at previous node results** - Context shows what data was passed to failed node

## Troubleshooting

### No audit events found
- Ensure workflow execution actually ran
- Check workspace spelling (case-sensitive)
- Verify audit logs exist at `workspace/{workspace_id}/runs/audit.log`

### Stack traces unclear
- Full traceback is in the JSON export
- Use `report` command for formatted output
- Check exception chain for root cause

### Missing node details
- Some failures may occur before node execution reaches audit logging
- Check initialization checkpoints
- Review execution phases in summary

