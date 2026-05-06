# Two Execution Paths: Studio vs Swarm

## Issue Found
Your "Architecture Pivot" workflow is a **SWARM workflow**, not a **STUDIO workflow**.

### Evidence
```json
{
  "execution_id": "16539c22-ff95-4c16-bdec-0a04ccc3160f",  // ← UUID format
  "status": "pending",
  "workflow": "strategic_architect",  // ← Internal name
  "workspace": "test4"
}
```

This is coming from `/api/workflow/execute` (swarm endpoint), not `/api/workflows/execute` (studio endpoint).

---

## Execution Path Comparison

### ✅ STUDIO Execution
**Endpoint:** `/api/workflows/execute` (POST)

**Response:**
```json
{
  "run_id": "run-abc12345",  // ← Short format: run-{8 hex chars}
  "status": "started"
}
```

**Event Streaming:** ✅ SSE via `/workflows/execute/{run_id}/events`
- Real-time node updates
- Events emitted as they happen

**Frontend UI:**
- Nodes highlight in real-time
- Progress bar fills
- Output shown as each node completes

**Use Case:** Visual node graphs built in Studio

---

### ⏳ SWARM Execution
**Endpoint:** `/api/workflow/execute` (POST)

**Response:**
```json
{
  "execution_id": "16539c22-ff95-4c16-bdec-0a04ccc3160f",  // ← Full UUID
  "status": "pending",
  "workflow": "strategic_architect",
  "workspace": "test4"
}
```

**Event Streaming:** ❌ No real-time streaming
- Backend runs as background task
- Frontend must **poll** for status updates

**Current Frontend Behavior:**
```javascript
const result = await response.json();
console.log('Swarm started:', result);
alert(`Swarm started! Execution ID: ${result.execution_id}`);  // ← Just shows alert!
// Then nothing happens - no polling!
```

**Frontend UI:**
- Shows alert with execution_id
- Then does nothing
- No progress or results shown

**Use Case:** Strategy YAML workflows with multi-wave execution

---

## Why You See Nothing

### Current Flow
1. ✅ User clicks "Execute"
2. ✅ Frontend sends request to `/api/workflow/execute`
3. ✅ Backend returns `execution_id` and starts background task
4. ✅ Frontend shows alert: "Swarm started! Execution ID: 16539c22..."
5. ❌ **Frontend never polls for updates**
6. ❌ Backend runs invisible background task
7. ❌ UI never updates with results
8. ❌ User sees nothing happening

### What Should Happen
1. ✅ User clicks "Execute"
2. ✅ Frontend sends request to `/api/workflow/execute`
3. ✅ Backend returns `execution_id` and starts background task
4. ✅ Frontend stores `execution_id` and **starts polling** `/workflow/{execution_id}/status`
5. ✅ Poll receives status updates from backend
6. ✅ Frontend updates UI with progress
7. ✅ When complete, show results

---

## Solution: Add Status Polling

### Option A: Poll `/workflow/{execution_id}/status` Endpoint

The endpoint already exists! Just need frontend to poll it:

```typescript
// In ExecutionBar.tsx handleSwarmExecute():
if (response.ok) {
  const result = await response.json();
  console.log('[AUDIT] Swarm started | execution_id:', result.execution_id);
  
  // Start polling for status updates
  const pollInterval = setInterval(async () => {
    try {
      const statusResponse = await fetch(
        `${API_BASE_URL}/api/workflow/${result.execution_id}/status`
      );
      if (statusResponse.ok) {
        const status = await statusResponse.json();
        console.log('[AUDIT] Status update:', status.status);
        
        // Update UI based on status
        if (status.status === 'running') {
          console.log('[AUDIT] Workflow running...');
        } else if (status.status === 'completed') {
          console.log('[AUDIT] Workflow completed!');
          console.log('[AUDIT] Result:', status.result);
          clearInterval(pollInterval);
        } else if (status.status === 'failed') {
          console.log('[AUDIT] Workflow failed:', status.error);
          clearInterval(pollInterval);
        }
      }
    } catch (err) {
      console.error('[AUDIT] Polling error:', err);
    }
  }, 2000);  // Poll every 2 seconds
}
```

### Option B: Create SSE Endpoint for Swarm (Recommended)

Add `/workflow/{execution_id}/events` SSE endpoint in backend:

```python
@router.get("/workflow/{execution_id}/events")
async def stream_workflow_events(execution_id: str):
    """SSE stream for swarm workflow events (same as studio)"""
    
    async def event_generator():
        last_status = None
        while True:
            if execution_id not in executions:
                yield f"data: {json.dumps({'type': 'error', 'message': 'Execution not found'})}\n\n"
                return
            
            execution = executions[execution_id]
            current_status = execution.get('status')
            
            if current_status != last_status:
                yield f"data: {json.dumps({'type': 'status_change', 'status': current_status})}\n\n"
                last_status = current_status
            
            if current_status in ('completed', 'failed'):
                yield f"data: {json.dumps({'type': 'workflow_finished', 'result': execution.get('result')})}\n\n"
                return
            
            await asyncio.sleep(1)
    
    return StreamingResponse(event_generator(), media_type="text/event-stream")
```

Then frontend uses same SSE pattern for both studio and swarm.

---

## Audit Logs Now Show
With the audit logging added:

**Backend logs:**
```
[AUDIT] POST /workflow/execute | workflow: strategic_architect | workspace: test4
[AUDIT] Created execution_id: 16539c22-ff95-4c16-bdec-0a04ccc3160f
[AUDIT] Workflow 'strategic_architect' is strategy type - routing to swarm
[AUDIT] Started background task for swarm: 16539c22-ff95-4c16-bdec-0a04ccc3160f
[AUDIT] Returning response: execution_id=16539c22-ff95-4c16-bdec-0a04ccc3160f, is_swarm=True
[AUDIT] Swarm background task started | execution_id: 16539c22-ff95-4c16-bdec-0a04ccc3160f | workflow: strategic_architect
[AUDIT] Marked execution as running: 16539c22-ff95-4c16-bdec-0a04ccc3160f
[AUDIT] Calling run_swarm_workflow...
[AUDIT] Swarm workflow completed | execution_id: 16539c22-ff95-4c16-bdec-0a04ccc3160f | status: completed
```

**Frontend console:**
```
[AUDIT] Starting swarm execution | workflow: strategic_architect
[AUDIT] Sending request to /api/workflow/execute
[AUDIT] Response received | status: 200 | ok: true
[AUDIT] Response parsed | execution_id: 16539c22-ff95-4c16-bdec-0a04ccc3160f | status: pending
```

---

## Key Differences Summary

| Aspect | Studio (`/workflows/execute`) | Swarm (`/workflow/execute`) |
|--------|---------|---------|
| **Node Type** | Visual graph in UI | YAML strategy file |
| **Run ID Format** | `run-abc12345` | UUID |
| **Response** | `{run_id, status}` | `{execution_id, status, workflow, workspace}` |
| **Event Streaming** | ✅ SSE `/workflows/execute/{run_id}/events` | ❌ None (need to add) |
| **Frontend Updates** | Real-time via SSE | Need polling or SSE |
| **Routing** | Based on node types | YAML file + type=strategy |
| **Execution Model** | Sequential node execution | Multi-wave swarm |

---

## Next Steps

### Immediate (Get It Working)
1. Add audit logging → **DONE** ✅
2. Test swarm execution with new logs
3. Share backend logs showing swarm execution progress

### Short Term (Improve UX)
4. Add polling to frontend for swarm status
5. Display progress while swarm is running
6. Show final results and artifacts

### Medium Term (Unified Experience)
7. Create SSE endpoint for swarm
8. Use same event streaming for both studio and swarm
9. Unified UI for both execution types

---

## How to Test

### Find Which Type Your Workflow Is
```powershell
# Check strategic_architect workflow file
cat C:\Users\nsdha\OneDrive\code\benny\workspace\test4\SOUL.md
# or
cat C:\Users\nsdha\OneDrive\code\benny\workspace\workflows\strategic_architect.yaml
```

### Confirm Swarm Execution
1. Click "Execute" button
2. Open browser console
3. Look for: `[AUDIT] Starting swarm execution`
4. Should see: `[AUDIT] Response parsed | execution_id: {UUID}`
5. Backend logs should show: `[AUDIT] Workflow 'strategic_architect' is strategy type - routing to swarm`

### Verify Backend is Running
```powershell
# In benny terminal, look for [AUDIT] logs
# Should see all the [AUDIT] logs listed above
```

If you don't see any backend logs, the API might not be receiving the request or logging isn't configured.
