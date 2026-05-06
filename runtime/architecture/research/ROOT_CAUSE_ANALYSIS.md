# Root Cause Analysis & Fix Plan

## Issue: UI Shows Nothing + Wrong Execution ID in Logs

### Evidence
```
GET /api/governance/verify-audit/9ab66287-6635-4821-9c85-7e11ee7a5002 HTTP/1.1" 200 OK
```
- UUID format (`9ab66287...`) instead of run_id format (`run-abc12345`)
- This indicates the frontend is NOT getting the correct `run_id` from backend response
- Frontend is either: (1) generating its own UUID, (2) receiving wrong response, or (3) not processing response correctly

---

## Root Cause Hypothesis

### Scenario A (Most Likely)
1. Backend `/api/workflows/execute` endpoint **fails silently**
2. Frontend never receives `run_id` 
3. Frontend defaults to generating its own UUID for tracking
4. SSE never connects to correct endpoint
5. UI shows nothing

### Scenario B
1. Backend returns response correctly
2. Frontend response parsing fails (JSON decode error)
3. `result.run_id` ends up `undefined`
4. Store uses undefined or generates fallback UUID

### Scenario C  
1. API response structure is different than expected
2. `result.run_id` doesn't exist in response object
3. Frontend logs `undefined` to store

---

## Solution: Comprehensive Audit Logging

Added `[AUDIT]` prefix logs at these critical points:

### Backend
- ✅ POST `/api/workflows/execute` receives request
- ✅ Generate run_id (`run-abc12345`)
- ✅ Return response object
- ✅ Background task starts
- ✅ Events emitted
- ✅ SSE connects and streams

### Frontend  
- ✅ Execute button clicked
- ✅ Fetch request sent
- ✅ Response received (HTTP status)
- ✅ Response parsed (JSON)
- ✅ Run ID extracted and stored
- ✅ SSE connection initiated
- ✅ Events received from SSE

---

## How to Run Next Test

### Step 1: Start Fresh
```powershell
# Kill and restart backend API
cd c:\Users\nsdha\OneDrive\code\benny
# Stop current process (Ctrl+C if running)
# Or: Stop-Process -Name python -Force

# Restart API (or use existing running instance)
python -m benny.api.server  # or however you start it
```

### Step 2: Start Frontend Dev Server
```powershell
cd c:\Users\nsdha\OneDrive\code\benny\frontend
npm run dev
# This will compile TSX with hot-reload and won't fail on unused imports
```

### Step 3: Open Browser
- Navigate to: `http://localhost:5173` (or whatever Vite shows)
- Open DevTools → Console tab

### Step 4: Execute Workflow
1. Click Execute button
2. Enter message when prompted
3. **Watch console for [AUDIT] logs**

### Step 5: Capture Logs
1. Copy ALL console [AUDIT] logs
2. Share what the **last** log entry is
3. Check if SSE connect logs appear

---

## What to Look For

### ✅ SUCCESS (Should see this sequence)
```
[AUDIT] Starting workflow execution | workspace: test4 | nodes: 7
[AUDIT] Sending request to /api/workflows/execute
[AUDIT] Response received | status: 200 | ok: true
[AUDIT] Response parsed | result: {run_id: "run-abc12345", status: "started"}
[AUDIT] Setting execution runId: run-abc12345
[AUDIT] Execution phase set to running with runId: run-abc12345
[AUDIT] Connecting to SSE | url: http://localhost:8005/api/workflows/execute/run-abc12345/events
[AUDIT] EventSource created for: run-abc12345
[AUDIT] SSE message received | type: node_started | nodeId: input_0
[AUDIT] Node started: input_0
...
```

### ❌ FAILURE (One of these stops)
- No logs at all → Frontend not executing or console not open
- Stops at "Sending request" → Fetch might be hanging/failing
- Stops at "Response received" → Response might be error
- Stops at "Response parsed" → JSON might be malformed
- Stops at "Setting execution" → run_id undefined
- Stops at "Connecting to SSE" → No SSE attempt
- Stops at "EventSource created" → Connection made but no events

---

## Backend Log Locations

### Option 1: Terminal Output
If running backend in terminal, [AUDIT] logs appear directly in stdout

### Option 2: Log Files
Check if logs are written to file:
```powershell
Get-Content "C:\Users\nsdha\OneDrive\code\benny\logs\api.log" -Tail 50
# or wherever logs are configured
```

### Option 3: Python stderr
Some logs might go to stderr. When starting API use:
```powershell
python -m benny.api.server 2>&1 | Tee-Object -FilePath "api.log"
```

---

## Files Modified for Auditing

1. ✅ `benny/api/studio_executor.py`
   - Added [AUDIT] logs to `/workflows/execute` endpoint
   - Added [AUDIT] logs to `/workflows/execute/{run_id}/events` SSE endpoint
   - Added [AUDIT] logs to background task
   - Added [AUDIT] logs to event emission function

2. ✅ `frontend/src/components/Studio/ExecutionBar.tsx`
   - Added [AUDIT] logs for Execute workflow flow

3. ✅ `frontend/src/components/Studio/LiveExecutionOverlay.tsx`
   - Added [AUDIT] logs for SSE connection and events

---

## Expected Behavior After Fix

When you click Execute:
1. UI should show brief loading spinner
2. Nodes should start highlighting one at a time (yellow → green/red)
3. Output tooltips should appear
4. Console should show [AUDIT] progression

---

## If Still Broken After Audit

Use the audit output to determine which step fails, then we can:

1. **If request never reaches backend:** Check network tab in DevTools
2. **If response malformed:** Log the actual response structure
3. **If events not emitted:** Check background task Is starting
4. **If SSE not connecting:** Check if endpoint exists and run_id is correct

The audit logs will tell us exactly where the chain breaks.

---

## Quick Reference

| Problem | Look For | Action |
|---------|----------|--------|
| Nothing in UI | No [AUDIT] logs in console | Frontend JavaScript not running |
| No response logs | Backend logs end at run_id creation | Background task may not be starting |
| Wrong UUID in verify | Frontend logs show undefined runId | Response parsing failed |
| Events not showing | "EventSource created" but no messages | SSE endpoint broken or wrong run_id |
| Nodes not highlighting | "Node started" but no visual update | React state not updating |
