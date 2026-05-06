# Complete Execution Flow Tracing Guide

## Problem Statement
- UI shows "nothing" when executing workflow
- Server logs show UUID verification request instead of run_id  
- Mismatch between backend run_id format and what frontend knows about

## Audit Trail Points

The execution flow should log with `[AUDIT]` prefix at these checkpoints:

### BACKEND (Python)

1. **API Receives Request**
   ```
   [AUDIT] /api/workflows/execute called | workspace=test4 | message=... | nodes=7 | edges=...
   ```

2. **Generate Run ID**
   ```
   [AUDIT] Created run_id: run-abc12345
   ```

3. **Initialize Buffers**
   ```
   [AUDIT] Initialized execution buffers for run-abc12345
   ```

4. **Return Response**
   ```
   [AUDIT] Returning response: {"run_id": "run-abc12345", "status": "started"}
   ```

5. **Background Task Starts**
   ```
   [AUDIT] Background task started | run_id: run-abc12345 | workspace: test4 | nodes: 7
   [AUDIT] Emitting initialization checkpoint for run-abc12345
   [AUDIT] Starting node execution loop for run-abc12345 | nodes: [input_0, strat_planner, ...]
   ```

6. **Each Node Execution**
   ```
   [AUDIT] Executing node input_0 (type: data) for run_id: run-abc12345
   [AUDIT] Event emitted | run_id: run-abc12345 | type: node_started | total events: 1
   ```

7. **SSE Stream Requested**
   ```
   [AUDIT] SSE stream requested for run_id: run-abc12345
   [AUDIT] Active run_ids in _execution_events: ['run-abc12345']
   [AUDIT] Event generator started for run-abc12345
   [AUDIT] Checking events for run-abc12345 | total events: 5 | last_index: 0
   [AUDIT] Yielding event #0 for run-abc12345 | type: node_started
   ```

### FRONTEND (TypeScript - Check Browser Console)

1. **Execute Button Clicked**
   ```
   [AUDIT] Starting workflow execution | workspace: test4 | nodes: 7 | message: give me a strategy...
   ```

2. **POST Request Sent**
   ```
   [AUDIT] Sending request to /api/workflows/execute
   ```

3. **Response Received**
   ```
   [AUDIT] Response received | status: 200 | ok: true
   [AUDIT] Response parsed | result: {run_id: "run-abc12345", status: "started"}
   [AUDIT] Setting execution runId: run-abc12345
   [AUDIT] Execution phase set to running with runId: run-abc12345
   ```

4. **SSE Connection Initiated**
   ```
   [AUDIT] Connecting to SSE | url: http://localhost:8005/api/workflows/execute/run-abc12345/events
   [AUDIT] EventSource created for: run-abc12345
   [AUDIT] Event generator started for run-abc12345
   ```

5. **Events Received**
   ```
   [AUDIT] SSE message received | type: node_started | nodeId: input_0
   [AUDIT] Node started: input_0
   ```

---

## Diagnostic Tips

### Step 1: Check Backend Logs
```powershell
# In benny API terminal:
# Look for [AUDIT] lines in the output
# Should see progression from /api/workflows/execute → Created run_id → Returning response → Background task started
```

### Step 2: Check Frontend Logs
```
1. Open browser DevTools → Console tab
2. Click Execute in UI
3. Look for [AUDIT] logs starting with "Starting workflow execution"
4. Should see POST response with run_id in format "run-XXXXXXXX"
```

### Step 3: Cross-Reference IDs
- Backend should generate: `run-abc12345` (8 hex chars after "run-")
- Frontend should receive: `run-abc12345` 
- SSE should request: `http://localhost:8005/api/workflows/execute/run-abc12345/events`

If you see:
- ❌ A full UUID like `9ab66287-6635-4821-9c85-7e11ee7a5002` → ID mismatch
- ✅ Format like `run-abc12345` → ID correct

### Step 4: Root Causes to Check

**If no [AUDIT] backend logs appear:**
- API server might not be receiving the request
- Check if port 8005 is accessible
- Check for network errors in browser console

**If backend logs appear but no frontend logs:**
- Frontend JavaScript not loading properly
- Check for JavaScript errors in browser console
- Check if TypeScript compiled correctly

**If frontend logs appear but no SSE events:**
- Check Network tab in DevTools → look for SSE request
- The SSE stream might not be connecting
- Look for SSE error in browser console: "[AUDIT] SSE connection lost"

**If SSE events appear but UI shows nothing:**
- React state might not be updating
- Check if node status is being set with `[AUDIT] Node started: {nodeId}`
- Check Redux/Zustand store is being updated

---

## How to Enable Verbose Logging

### Backend
Already enabled - logs include `[AUDIT]` prefix in all output

### Frontend
Logs are automatically enabled in browser console.

To filter:
```javascript
// In browser console:
// Filter only AUDIT logs:
console.log.bind(console, '[AUDIT]')

// Or use console filter dropdown → "Filter: [AUDIT]"
```

---

## Common Scenarios

### Scenario 1: "Response received | status: 200" but no runId
**Cause:** Response body might be different than expected
**Fix:** Check what `result` actually contains:
```typescript
// In ExecutionBar, add:
console.log('Full response:', JSON.stringify(result));
```

### Scenario 2: SSE "no events" even though backend shows node_started
**Cause:** Event flag not being signaled or events not in buffer
**Fix:** Check backend logs:
```
[AUDIT] Event emitted | type: node_started | total events: 1
[AUDIT] Signaled event flag for run-abc12345
```

### Scenario 3: Events stop after "node_started"
**Cause:** Node execution might be stuck
**Fix:** Check:
```
[AUDIT] Executing node input_0 (type: data) for run_id:...
```
followed by no completion event

### Scenario 4: UUID in verification request instead of run_id
**Cause:** Either:
- Backend never returned run_id
- Frontend using wrong source for the ID
**Fix:** 
1. Verify backend returned: `{"run_id": "run-abc12345", "status": "started"}`
2. Check frontend received: `[AUDIT] Response parsed | result: {run_id: "run-abc12345", ...}`
3. Check stored: `[AUDIT] Setting execution runId: run-abc12345`

---

## Next Test Run Steps

1. **Clear logs:**
   - Browser console: right-click → Clear console
   - Backend: none needed (logs append)

2. **Trigger workflow:**
   - Click Execute button
   - Enter message when prompted

3. **Capture logs:**
   - Screenshot or copy backend [AUDIT] logs
   - Screenshot browser console [AUDIT] logs

4. **Analyze flow:**
   - Verify runId format matches
   - Verify events are being emitted
   - Verify SSE is connecting

5. **Report findings:**
   - What's the last [AUDIT] log from backend?
   - What's the last [AUDIT] log from frontend?
   - Is there an error message?

---

## Emergency Debugging
If logs don't appear to help, try:

```python
# Add to studio_executor.py after imports:
import sys
logging.basicConfig(
    level=logging.DEBUG,
    format='[%(asctime)s] %(levelname)s: %(message)s',
    stream=sys.stdout  # Force to stdout instead of stderr
)
```

This will show ALL logs including print statements.
