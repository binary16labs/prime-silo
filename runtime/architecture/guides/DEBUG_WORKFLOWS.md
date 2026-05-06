# Benny Studio Workflow Execution - Debugging Guide

## Issue Identified and Fixed

### Root Cause
The "architecture pivot" workflow was failing because the data node reading the input file was missing the `path` configuration field. The node only had:
```json
{
  "label": "FrolovRoutledge2024.md",
  "config": { "operation": "read" }
}
```

This caused the code to attempt reading an empty filename, resulting in:
```
[Errno 13] Permission denied: 'C:\...\workspace\test4\data_in'
```

### Fixes Applied

#### Fix #1: Fallback Path Configuration (Lines 249-254)
File: `benny/api/studio_executor.py`

**Before:**
```python
filename = config.get("path", "")  # Empty string default
```

**After:**
```python
filename = config.get("path") or node.data.get("label", "")

if not filename:
    return {
        "error": "Data node read operation requires 'path' in config or 'label' for filename",
        "hint": "Configure the path field or ensure label contains the filename"
    }
```

Now uses `label` as automatic fallback if `path` is not specified.

#### Fix #2: Background Task Exception Handling (Lines 635-648)
File: `benny/api/studio_executor.py`

**Added:**
```python
# Add callback to handle unhandled exceptions in background task
def handle_exception(future):
    try:
        future.result()
    except Exception as e:
        logging.error(f"Unhandled exception in workflow {run_id}: {str(e)}", exc_info=True)
        try:
            emit_execution_failure(
                run_id,
                request.workspace,
                ExecutionPhase.EXECUTION,
                e,
                context={"error_location": "task callback"}
            )
            task_manager.update_task(run_id, status="failed", message=f"Background task failed: {str(e)[:200]}")
        except Exception as callback_error:
            logging.error(f"Failed to emit failure for {run_id}: {str(callback_error)}")

task.add_done_callback(handle_exception)
```

This ensures all background execution failures are properly logged and recorded.

## Pre-Flight Checklist

Before running the workflow, verify:

### 1. LLM Backend is Running
```powershell
# Check if Lemonade/Ollama is running
curl http://localhost:9999/api/version
# OR for Ollama
curl http://localhost:11434/api/tags
```

Expected: HTTP 200 response

### 2. Input Files Exist
```powershell
Get-ChildItem "C:\Users\nsdha\OneDrive\code\benny\workspace\test4\data_in"
```

Expected: Should list `FrolovRoutledge2024.md`

### 3. Backend Server is Running
```powershell
# Check if API is running
curl http://localhost:8005/api/health
```

Expected: HTTP 200 with health status

### 4. ChromaDB is Ingested
The knowledge base should already be populated from the previous ingestion tasks.

## Testing the Workflow

### Step 1: Start Fresh
Clear old execution cache to avoid conflicts:

```powershell
# Backup old runs
Copy-Item "C:\Users\nsdha\OneDrive\code\benny\workspace\test4\runs" `
          "C:\Users\nsdha\OneDrive\code\benny\workspace\test4\runs.backup"

# Clear execution events cache (only affects in-memory SSE events, not audit trail)
```

### Step 2: Trigger from UI
1. Open Benny Studio UI
2. Load or create "Architecture Pivot" workflow  
3. Ensure you have the node graph:
   - **input_0**: Data node with label "FrolovRoutledge2024.md" & data retrieval
   - **strat_planner**: LLM node for planning
   - **strat_logic**: Logic node for orchestration  
   - **strat_worker**: Worker node for execution
   - **strat_data**: Data output node
   - **output_0**: Final delivery node

4. Click "Execute" button
5. When prompted, enter: `"give me a strategy on how to create and govern an AI agent army"`

### Step 3: Monitor Execution
The UI should:
1. Show a **Loading spinner** while workflow initializes
2. Display **node status updates** as each node executes:
   - `node_started` → node highlighting turns yellow
   - `node_completed` → node highlighting turns green + shows output
   - `node_error` → node highlighting turns red + shows error

3. For each node you should see:
   - Execution time in the node
   - Output text in a hover tooltip
   - Error messages if failed

4. Final states:
   - `workflow_completed` → "Execution Complete" dialog
   - `workflow_failed` → "Execution Failed" dialog with error details

### Step 4: Verify Audit Trail
Check the recorded events:

```powershell
# View latest execution results
$audit = Get-Content "C:\Users\nsdha\OneDrive\code\benny\workspace\test4\runs\audit.log" -Tail 50
$audit | ConvertFrom-Json | Select-Object event_type | Sort-Object | Get-Unique
```

Expected events:
- `TASK_METADATA_UPDATE` (status changes)
- `LINEAGE_START_WORKFLOW` (workflow start)
- `EXECUTION_CHECKPOINT` (initialization, nodes, finalization)
- `NODE_EXECUTION_STATE` (node results)
- (NO ERROR events if successful)

### Step 5: Check Output
After successful execution:

```powershell
# View generated artifacts
Get-ChildItem "C:\Users\nsdha\OneDrive\code\benny\workspace\test4\data_out" -File
```

Expected: New Markdown files with generated strategy and artifacts

## Troubleshooting

### Issue: "SSE Connection Lost" in Console
**Cause:** Backend not returning events properly
**Solution:**
1. Check API logs: `tail -f logs/api.log`
2. Verify SSE endpoint responding: `curl http://localhost:8005/api/workflows/execute/{run_id}/events`

### Issue: Workflow Marked "Running" But No Progress
**Cause:** Background task stuck or not started
**Solution:**
1. Check Python process is running and not hung
2. Look for errors in API logs
3. Kill stuck process: `Stop-Process -Name python -Force`
4. Restart backend

### Issue: File Not Found Error for Input
**Cause:** Node config still missing `path` field
**Solution:**
1. Verify data node has `path` in config: 
   ```javascript
   { "operation": "read", "path": "FrolovRoutledge2024.md" }
   ```
2. Or ensure `label` is set correctly in node data

### Issue: LLM ConnectionRefusedError  
**Cause:** LLM backend not running
**Solution:**
1. Start Lemonade: `python -m lemonade_server`
2. Or start Ollama: `ollama serve`
3. Wait 5 seconds for server to be ready
4. Retry workflow

## Code Changes Summary

Files modified:
- `benny/api/studio_executor.py` - Lines 249-254 (data node path fallback) and 635-648 (exception handling)

These are the **only required changes** for the fix. If you're getting "File not found" with a blank filename, ensure you're running the updated code with these changes.

## Next Steps

1. ✅ Clear old cache if needed
2. ⏳ Start LLM backend
3. ⏳ Verify all services running
4. ⏳ Trigger workflow from UI
5. ⏳ Monitor SSE events in browser console
6. ⏳ Review audit trail for results
