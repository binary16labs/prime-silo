# Phase 5 — Enhanced Studio UI & HITL

> **Owner**: Implementation Agent  
> **PRD Reference**: `C:\Users\nsdha\OneDrive\code\benny\docs\requirements\5\PRD_dog_pound.txt`  
> **Parent Plan**: `C:\Users\nsdha\.gemini\antigravity\brain\fd945150-1e44-4e58-baa2-97d8004a2eb2\implementation_plan.md`  
> **Priority**: Core UX — most visible impact  
> **Estimated Scope**: 3 new frontend components, 4 modified frontend files, 2 modified backend files

---

## 1. Objective

Transform the Studio from a static canvas into a **live orchestration cockpit** with:
1. Real-time execution visualization (animated edges, pulsing nodes, execution timers)
2. Auto-generated HITL (Human-in-the-Loop) approval forms when a workflow pauses
3. SSE-based streaming execution events from backend to frontend
4. Rich result rendering with AER (Agent Execution Record) reasoning traces

---

## 2. Current State (READ THESE FILES FIRST)

| File | Purpose | Why You Need It |
|------|---------|-----------------|
| `C:\Users\nsdha\OneDrive\code\benny\frontend\src\components\Studio\WorkflowCanvas.tsx` | ReactFlow canvas, nodeTypes, drag/drop | You will overlay live execution states |
| `C:\Users\nsdha\OneDrive\code\benny\frontend\src\components\Studio\ExecutionBar.tsx` | Execute/Save/Swarm buttons, execution logic | You will replace polling with SSE |
| `C:\Users\nsdha\OneDrive\code\benny\frontend\src\hooks\useWorkflowStore.ts` | Zustand store for nodes/edges/execution state | You will add execution phase + HITL state |
| `C:\Users\nsdha\OneDrive\code\benny\frontend\src\components\Studio\ConfigPanel.tsx` | Node configuration panel | Reference for styling patterns |
| `C:\Users\nsdha\OneDrive\code\benny\frontend\src\App.tsx` | Main app layout, Studio/Notebook toggle | Reference for component integration |
| `C:\Users\nsdha\OneDrive\code\benny\benny\api\studio_executor.py` | Backend workflow execution | You will add SSE streaming endpoint |
| `C:\Users\nsdha\OneDrive\code\benny\benny\api\workflow_routes.py` | Workflow CRUD and execution routing | You will add HITL response endpoint |
| `C:\Users\nsdha\OneDrive\code\benny\frontend\src\constants.ts` | API_BASE_URL, GOVERNANCE_HEADERS | Use for all fetch calls |

---

## 3. Files to Create or Modify

### 3.1 [MODIFY] `C:\Users\nsdha\OneDrive\code\benny\frontend\src\hooks\useWorkflowStore.ts`

Add these new state fields and actions to the EXISTING Zustand store. Do NOT remove anything.

#### New State Fields (add to the WorkflowState interface):

```typescript
// === NEW FIELDS ===
executionPhase: 'idle' | 'running' | 'paused_hitl' | 'completed' | 'failed';
currentExecutingNodeId: string | null;
hitlPendingData: HITLRequest | null;
executionRunId: string | null;         // Backend run ID for SSE streaming
nodeExecutionTimers: Record<string, number>;  // nodeId → start timestamp (ms)
executionEvents: ExecutionEvent[];      // Ordered list of received SSE events
reasoningTraces: Record<string, AERTrace>;  // nodeId → reasoning trace data
```

#### New Type Definitions (add at top of file or in a separate types file):

```typescript
interface HITLRequest {
  nodeId: string;
  nodeName: string;
  action_description: string;
  reasoning: string;           // AER facet data
  current_state_summary: string;
  options: Array<{
    label: string;
    value: string;
    description?: string;
  }>;
}

interface ExecutionEvent {
  type: 'node_started' | 'node_completed' | 'node_error' | 'hitl_required' | 'workflow_completed' | 'workflow_failed';
  nodeId?: string;
  timestamp: number;
  data?: any;
}

interface AERTrace {
  intent: string;
  observation: string;
  inference: string;
  plan: string;
}
```

#### New Actions (add to the store creation):

```typescript
// === NEW ACTIONS ===
setExecutionPhase: (phase: WorkflowState['executionPhase']) => void;
setCurrentExecutingNodeId: (nodeId: string | null) => void;
setHitlPendingData: (data: HITLRequest | null) => void;
setExecutionRunId: (runId: string | null) => void;
addExecutionEvent: (event: ExecutionEvent) => void;
setReasoningTrace: (nodeId: string, trace: AERTrace) => void;
startNodeTimer: (nodeId: string) => void;
stopNodeTimer: (nodeId: string) => void;
resetExecution: () => void;  // Full reset of all execution state
```

#### Action Implementations:

```typescript
setExecutionPhase: (phase) => set({ executionPhase: phase }),

setCurrentExecutingNodeId: (nodeId) => set({ currentExecutingNodeId: nodeId }),

setHitlPendingData: (data) => set({ 
    hitlPendingData: data,
    executionPhase: data ? 'paused_hitl' : get().executionPhase 
}),

setExecutionRunId: (runId) => set({ executionRunId: runId }),

addExecutionEvent: (event) => set({ 
    executionEvents: [...get().executionEvents, event] 
}),

setReasoningTrace: (nodeId, trace) => set({
    reasoningTraces: { ...get().reasoningTraces, [nodeId]: trace }
}),

startNodeTimer: (nodeId) => set({
    nodeExecutionTimers: { ...get().nodeExecutionTimers, [nodeId]: Date.now() }
}),

stopNodeTimer: (nodeId) => {
    const timers = { ...get().nodeExecutionTimers };
    delete timers[nodeId];
    set({ nodeExecutionTimers: timers });
},

resetExecution: () => set({
    executionPhase: 'idle',
    currentExecutingNodeId: null,
    hitlPendingData: null,
    executionRunId: null,
    nodeExecutionTimers: {},
    executionEvents: [],
    reasoningTraces: {},
    executionStatus: {},
    nodeOutputs: {},
}),
```

#### Default Initial Values:

```typescript
executionPhase: 'idle',
currentExecutingNodeId: null,
hitlPendingData: null,
executionRunId: null,
nodeExecutionTimers: {},
executionEvents: [],
reasoningTraces: {},
```

---

### 3.2 [MODIFY] `C:\Users\nsdha\OneDrive\code\benny\benny\api\studio_executor.py`

Add an SSE streaming endpoint for real-time execution events.

#### Add these imports at top:

```python
from fastapi.responses import StreamingResponse
import asyncio
import json
from typing import AsyncGenerator
```

#### Add an in-memory event buffer (below existing `executions` dict):

```python
# Event buffers for SSE streaming (run_id → list of SSE event dicts)
_execution_events: Dict[str, list] = {}
_execution_event_flags: Dict[str, asyncio.Event] = {}
```

#### Add helper to emit events:

```python
def _emit_execution_event(run_id: str, event_type: str, data: Dict[str, Any]):
    """Push an event into the buffer for SSE consumers."""
    if run_id not in _execution_events:
        _execution_events[run_id] = []
    event = {
        "type": event_type,
        "timestamp": datetime.now().isoformat(),
        **data,
    }
    _execution_events[run_id].append(event)
    # Signal any waiting SSE consumers
    flag = _execution_event_flags.get(run_id)
    if flag:
        flag.set()
```

#### Add SSE streaming endpoint:

```python
@router.get("/workflows/execute/{run_id}/events")
async def stream_execution_events(run_id: str):
    """
    SSE endpoint for real-time execution events.
    
    Events:
      - node_started: {"nodeId": "...", "nodeName": "..."}
      - node_completed: {"nodeId": "...", "output": "..."}
      - node_error: {"nodeId": "...", "error": "..."}
      - hitl_required: {"nodeId": "...", "action_description": "...", "reasoning": "...", "options": [...]}
      - workflow_completed: {"outputs": {...}}
      - workflow_failed: {"error": "..."}
    """
    async def event_generator() -> AsyncGenerator[str, None]:
        _execution_event_flags[run_id] = asyncio.Event()
        last_index = 0
        
        while True:
            events = _execution_events.get(run_id, [])
            
            while last_index < len(events):
                event = events[last_index]
                yield f"data: {json.dumps(event)}\n\n"
                last_index += 1
                
                # Check if execution is done
                if event["type"] in ("workflow_completed", "workflow_failed"):
                    return
            
            # Wait for new events
            _execution_event_flags[run_id].clear()
            try:
                await asyncio.wait_for(_execution_event_flags[run_id].wait(), timeout=30.0)
            except asyncio.TimeoutError:
                # Send heartbeat
                yield f"data: {json.dumps({'type': 'heartbeat'})}\n\n"
    
    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        }
    )
```

#### Modify `execute_studio_workflow` to emit events:

In the existing execution loop where nodes are processed, add event emissions:

```python
# BEFORE executing each node:
_emit_execution_event(run_id, "node_started", {
    "nodeId": node.id,
    "nodeName": str(node.data.get("label", node.type)),
})

# AFTER successful node execution:
_emit_execution_event(run_id, "node_completed", {
    "nodeId": node.id,
    "output": str(output)[:500],  # Truncate for SSE
})

# ON node error:
_emit_execution_event(run_id, "node_error", {
    "nodeId": node.id,
    "error": str(error),
})

# AT workflow completion:
_emit_execution_event(run_id, "workflow_completed", {
    "outputs": final_output or {},
})

# ON workflow failure:
_emit_execution_event(run_id, "workflow_failed", {
    "error": str(error),
})
```

The execute endpoint should return a `run_id` immediately so the frontend can subscribe to SSE:

```python
# At the beginning of execute_studio_workflow:
run_id = f"run-{uuid.uuid4().hex[:8]}"
_execution_events[run_id] = []

# Return immediately with run_id, execute in background
return {"run_id": run_id, "status": "started"}
```

#### Add HITL response endpoint:

```python
@router.post("/workflows/execute/{run_id}/hitl-response")
async def submit_hitl_response(run_id: str, response: Dict[str, Any]):
    """
    Submit a HITL response to resume a paused workflow.
    
    Body:
      {"decision": "approve" | "reject" | "edit", "edits": {...}}
    """
    # Store the response for the execution loop to pick up
    if run_id not in _execution_events:
        raise HTTPException(404, f"Run not found: {run_id}")
    
    _emit_execution_event(run_id, "hitl_response", {
        "decision": response.get("decision", "approve"),
        "edits": response.get("edits", {}),
    })
    
    return {"status": "received", "run_id": run_id}
```

---

### 3.3 [NEW] `C:\Users\nsdha\OneDrive\code\benny\frontend\src\components\Studio\LiveExecutionOverlay.tsx`

This component overlays execution state on top of the WorkflowCanvas.

```tsx
import { useEffect, useState, useRef } from 'react';
import { useWorkflowStore } from '../../hooks/useWorkflowStore';
import { API_BASE_URL } from '../../constants';

export default function LiveExecutionOverlay() {
  const {
    executionPhase,
    executionRunId,
    setExecutionPhase,
    setCurrentExecutingNodeId,
    setHitlPendingData,
    addExecutionEvent,
    setReasoningTrace,
    startNodeTimer,
    stopNodeTimer,
  } = useWorkflowStore();
  
  const nodes = useWorkflowStore((s) => s.nodes);
  const setNodes = useWorkflowStore((s) => s.setNodes);
  const eventSourceRef = useRef<EventSource | null>(null);

  // Connect to SSE when execution starts
  useEffect(() => {
    if (executionPhase !== 'running' || !executionRunId) return;

    const url = `${API_BASE_URL}/api/workflows/execute/${executionRunId}/events`;
    const eventSource = new EventSource(url);
    eventSourceRef.current = eventSource;

    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'heartbeat') return;

        addExecutionEvent({
          type: data.type,
          nodeId: data.nodeId,
          timestamp: Date.now(),
          data,
        });

        switch (data.type) {
          case 'node_started':
            setCurrentExecutingNodeId(data.nodeId);
            startNodeTimer(data.nodeId);
            // Update node visual status
            setNodes(nodes.map(n => 
              n.id === data.nodeId 
                ? { ...n, data: { ...n.data, status: 'running' } }
                : n
            ));
            break;

          case 'node_completed':
            stopNodeTimer(data.nodeId);
            setNodes(nodes.map(n =>
              n.id === data.nodeId
                ? { ...n, data: { ...n.data, status: 'success', executionOutput: data.output } }
                : n
            ));
            if (data.reasoning) {
              setReasoningTrace(data.nodeId, data.reasoning);
            }
            break;

          case 'node_error':
            stopNodeTimer(data.nodeId);
            setNodes(nodes.map(n =>
              n.id === data.nodeId
                ? { ...n, data: { ...n.data, status: 'error', executionOutput: data.error } }
                : n
            ));
            break;

          case 'hitl_required':
            setHitlPendingData({
              nodeId: data.nodeId,
              nodeName: data.nodeName || 'Unknown',
              action_description: data.action_description || '',
              reasoning: data.reasoning || '',
              current_state_summary: data.current_state_summary || '',
              options: data.options || [
                { label: 'Approve', value: 'approve' },
                { label: 'Reject', value: 'reject' },
              ],
            });
            break;

          case 'workflow_completed':
            setExecutionPhase('completed');
            setCurrentExecutingNodeId(null);
            break;

          case 'workflow_failed':
            setExecutionPhase('failed');
            setCurrentExecutingNodeId(null);
            break;
        }
      } catch (e) {
        console.error('SSE parse error:', e);
      }
    };

    eventSource.onerror = () => {
      console.warn('SSE connection lost');
      eventSource.close();
    };

    return () => {
      eventSource.close();
      eventSourceRef.current = null;
    };
  }, [executionPhase, executionRunId]);

  if (executionPhase === 'idle') return null;

  return (
    <div style={{
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      zIndex: 100,
      pointerEvents: 'none',
    }}>
      {/* Execution phase indicator */}
      <div style={{
        display: 'flex',
        justifyContent: 'center',
        padding: '8px',
        pointerEvents: 'auto',
      }}>
        <div style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: '8px',
          padding: '6px 16px',
          borderRadius: '20px',
          fontSize: '12px',
          fontWeight: 600,
          background: executionPhase === 'running'
            ? 'rgba(139, 92, 246, 0.2)'
            : executionPhase === 'paused_hitl'
            ? 'rgba(245, 158, 11, 0.2)'
            : executionPhase === 'completed'
            ? 'rgba(34, 197, 94, 0.2)'
            : 'rgba(239, 68, 68, 0.2)',
          border: `1px solid ${
            executionPhase === 'running' ? '#8b5cf6'
            : executionPhase === 'paused_hitl' ? '#f59e0b'
            : executionPhase === 'completed' ? '#22c55e'
            : '#ef4444'
          }`,
          color: '#fff',
          backdropFilter: 'blur(8px)',
        }}>
          {executionPhase === 'running' && (
            <span className="animate-pulse" style={{ width: 8, height: 8, borderRadius: '50%', background: '#8b5cf6', display: 'inline-block' }} />
          )}
          {executionPhase === 'running' ? '⚡ Executing...'
            : executionPhase === 'paused_hitl' ? '⏸ Waiting for Approval'
            : executionPhase === 'completed' ? '✅ Completed'
            : '❌ Failed'}
        </div>
      </div>
    </div>
  );
}
```

---

### 3.4 [NEW] `C:\Users\nsdha\OneDrive\code\benny\frontend\src\components\Studio\HITLFormPanel.tsx`

Auto-generated HITL intervention form.

```tsx
import { useState } from 'react';
import { ShieldCheck, ShieldX, Edit3, Brain, AlertTriangle } from 'lucide-react';
import { useWorkflowStore } from '../../hooks/useWorkflowStore';
import { API_BASE_URL, GOVERNANCE_HEADERS } from '../../constants';

export default function HITLFormPanel() {
  const hitlData = useWorkflowStore((s) => s.hitlPendingData);
  const executionRunId = useWorkflowStore((s) => s.executionRunId);
  const setHitlPendingData = useWorkflowStore((s) => s.setHitlPendingData);
  const setExecutionPhase = useWorkflowStore((s) => s.setExecutionPhase);
  const [submitting, setSubmitting] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [edits, setEdits] = useState('');

  if (!hitlData) return null;

  const handleDecision = async (decision: string) => {
    if (!executionRunId) return;
    
    setSubmitting(true);
    try {
      const response = await fetch(
        `${API_BASE_URL}/api/workflows/execute/${executionRunId}/hitl-response`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...GOVERNANCE_HEADERS },
          body: JSON.stringify({
            decision,
            edits: editMode ? { modified_content: edits } : {},
          }),
        }
      );
      
      if (response.ok) {
        setHitlPendingData(null);
        setExecutionPhase('running');
      }
    } catch (e) {
      console.error('HITL response failed:', e);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div style={{
      position: 'absolute',
      bottom: '20px',
      left: '50%',
      transform: 'translateX(-50%)',
      zIndex: 200,
      background: 'rgba(15, 15, 30, 0.95)',
      border: '1px solid rgba(245, 158, 11, 0.4)',
      borderRadius: '16px',
      padding: '20px',
      width: '500px',
      maxHeight: '400px',
      overflowY: 'auto',
      backdropFilter: 'blur(16px)',
      boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
    }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px' }}>
        <AlertTriangle size={20} style={{ color: '#f59e0b' }} />
        <h3 style={{ margin: 0, fontSize: '15px', fontWeight: 600, color: '#fff' }}>
          Human Approval Required
        </h3>
      </div>

      {/* Node info */}
      <div style={{ fontSize: '12px', color: 'var(--text-tertiary)', marginBottom: '8px' }}>
        Node: <strong style={{ color: '#fff' }}>{hitlData.nodeName}</strong>
      </div>

      {/* Action description */}
      <div style={{
        padding: '12px',
        background: 'rgba(255,255,255,0.05)',
        borderRadius: '8px',
        fontSize: '13px',
        color: 'var(--text-secondary)',
        marginBottom: '12px',
      }}>
        <strong style={{ color: '#fff' }}>Intended Action:</strong>
        <p style={{ margin: '4px 0 0 0' }}>{hitlData.action_description}</p>
      </div>

      {/* Reasoning trace */}
      {hitlData.reasoning && (
        <div style={{
          padding: '12px',
          background: 'rgba(139, 92, 246, 0.1)',
          border: '1px solid rgba(139, 92, 246, 0.2)',
          borderRadius: '8px',
          fontSize: '12px',
          marginBottom: '12px',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '6px' }}>
            <Brain size={14} style={{ color: '#8b5cf6' }} />
            <strong style={{ color: '#8b5cf6' }}>Agent Reasoning (AER)</strong>
          </div>
          <p style={{ margin: 0, color: 'var(--text-secondary)', whiteSpace: 'pre-wrap' }}>
            {hitlData.reasoning}
          </p>
        </div>
      )}

      {/* Current state */}
      {hitlData.current_state_summary && (
        <div style={{
          padding: '8px 12px',
          background: 'rgba(255,255,255,0.03)',
          borderRadius: '6px',
          fontSize: '11px',
          color: 'var(--text-tertiary)',
          marginBottom: '12px',
        }}>
          <strong>Current State:</strong> {hitlData.current_state_summary}
        </div>
      )}

      {/* Edit mode */}
      {editMode && (
        <div style={{ marginBottom: '12px' }}>
          <textarea
            style={{
              width: '100%',
              minHeight: '80px',
              padding: '8px',
              background: 'rgba(0,0,0,0.3)',
              border: '1px solid var(--border-color)',
              borderRadius: '6px',
              color: '#fff',
              fontSize: '12px',
              fontFamily: 'monospace',
              resize: 'vertical',
            }}
            placeholder="Enter your modifications..."
            value={edits}
            onChange={(e) => setEdits(e.target.value)}
          />
        </div>
      )}

      {/* Decision buttons */}
      <div style={{ display: 'flex', gap: '8px' }}>
        <button
          className="btn btn-gradient"
          disabled={submitting}
          onClick={() => handleDecision('approve')}
          style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}
        >
          <ShieldCheck size={16} /> Approve
        </button>
        <button
          className="btn btn-outline"
          disabled={submitting}
          onClick={() => handleDecision('reject')}
          style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}
        >
          <ShieldX size={16} /> Reject
        </button>
        <button
          className="btn btn-outline"
          disabled={submitting}
          onClick={() => {
            if (editMode && edits) {
              handleDecision('edit');
            } else {
              setEditMode(!editMode);
            }
          }}
          style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}
        >
          <Edit3 size={16} /> {editMode ? 'Submit Edit' : 'Edit'}
        </button>
      </div>
    </div>
  );
}
```

---

### 3.5 [NEW] `C:\Users\nsdha\OneDrive\code\benny\frontend\src\components\Studio\ReasoningTracePopover.tsx`

Small popover shown when hovering over an LLM node that has executed. Shows the AER data.

```tsx
import { Brain } from 'lucide-react';
import { useWorkflowStore } from '../../hooks/useWorkflowStore';

interface ReasoningTracePopoverProps {
  nodeId: string;
}

export default function ReasoningTracePopover({ nodeId }: ReasoningTracePopoverProps) {
  const trace = useWorkflowStore((s) => s.reasoningTraces[nodeId]);

  if (!trace) return null;

  return (
    <div style={{
      position: 'absolute',
      top: '100%',
      left: '50%',
      transform: 'translateX(-50%)',
      zIndex: 50,
      background: 'rgba(15, 15, 30, 0.95)',
      border: '1px solid rgba(139, 92, 246, 0.3)',
      borderRadius: '8px',
      padding: '12px',
      width: '280px',
      fontSize: '11px',
      backdropFilter: 'blur(8px)',
      pointerEvents: 'none',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '8px' }}>
        <Brain size={12} style={{ color: '#8b5cf6' }} />
        <strong style={{ color: '#8b5cf6' }}>Reasoning Trace</strong>
      </div>
      {trace.intent && (
        <div style={{ marginBottom: '4px' }}>
          <span style={{ color: 'var(--text-tertiary)' }}>Intent:</span>{' '}
          <span style={{ color: '#fff' }}>{trace.intent}</span>
        </div>
      )}
      {trace.observation && (
        <div style={{ marginBottom: '4px' }}>
          <span style={{ color: 'var(--text-tertiary)' }}>Observation:</span>{' '}
          <span style={{ color: '#fff' }}>{trace.observation}</span>
        </div>
      )}
      {trace.inference && (
        <div style={{ marginBottom: '4px' }}>
          <span style={{ color: 'var(--text-tertiary)' }}>Inference:</span>{' '}
          <span style={{ color: '#fff' }}>{trace.inference}</span>
        </div>
      )}
    </div>
  );
}
```

---

### 3.6 [MODIFY] `C:\Users\nsdha\OneDrive\code\benny\frontend\src\components\Studio\WorkflowCanvas.tsx`

Integrate the LiveExecutionOverlay and HITLFormPanel:

Add imports:
```tsx
import LiveExecutionOverlay from './LiveExecutionOverlay';
import HITLFormPanel from './HITLFormPanel';
```

Wrap the return in a container div and add the overlays:

```tsx
return (
  <div style={{ position: 'relative', width: '100%', height: '100%' }}>
    <ReactFlow
      {/* ... existing props ... */}
    >
      {/* ... existing children (Background, Controls, MiniMap) ... */}
    </ReactFlow>
    <LiveExecutionOverlay />
    <HITLFormPanel />
  </div>
);
```

---

### 3.7 [MODIFY] `C:\Users\nsdha\OneDrive\code\benny\frontend\src\components\Studio\ExecutionBar.tsx`

Refactor `handleExecute` to use SSE instead of waiting for the entire response:

```tsx
const handleExecute = async () => {
    if (nodes.length === 0) {
      alert('Please add nodes to your workflow first');
      return;
    }

    const hasTrigger = nodes.some(n => n.type === 'trigger');
    let message = '';
    if (hasTrigger) {
      const prompted = prompt('Enter your message for this workflow:', 'Tell me about...');
      if (prompted === null) return;
      message = prompted;
    }

    // Reset execution state
    const store = useWorkflowStore.getState();
    store.resetExecution();
    store.setExecutionPhase('running');
    
    // Mark all nodes as pending
    setNodes(nodes.map(n => ({ ...n, data: { ...n.data, status: 'pending' } })));
    setExecuting(true);

    try {
      const response = await fetch(`${API_BASE_URL}/api/workflows/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...GOVERNANCE_HEADERS },
        body: JSON.stringify({ nodes, edges, workspace: currentWorkspace, message }),
      });

      if (response.ok) {
        const result = await response.json();
        // Store the run_id and let the SSE handler take over
        store.setExecutionRunId(result.run_id);
        // Don't set executing=false here — the SSE handler will do it
      } else {
        const errText = await response.text();
        alert('Execution failed: ' + errText);
        store.setExecutionPhase('failed');
        setExecuting(false);
      }
    } catch (error) {
      console.error('Execution error:', error);
      store.setExecutionPhase('failed');
      setExecuting(false);
    }
};
```

---

## 4. BDD Acceptance Criteria

```gherkin
Feature: Live Execution Visualization

  Scenario: Nodes change visual state during execution
    Given a workflow with 3 nodes (trigger → llm → data)
    When execution starts
    Then all nodes should show "pending" status
    And the currently executing node should show "running" with a pulsing effect
    And completed nodes should show "success" with a green indicator
    And an execution phase banner should show "⚡ Executing..."

  Scenario: Execution events stream via SSE
    Given execution has started and a run_id is returned
    When the frontend subscribes to /api/workflows/execute/{run_id}/events
    Then it should receive "node_started" events as each node begins
    And "node_completed" events with output data
    And a final "workflow_completed" event

Feature: HITL Approval Form

  Scenario: Workflow pauses for human approval
    Given a workflow with a node that requires_approval = true
    When execution reaches that node
    Then the SSE stream should emit "hitl_required"
    And the execution phase should change to "paused_hitl"
    And the HITL form panel should appear showing:
      - Node name
      - Intended action description
      - Agent reasoning (AER)
      - Approve / Reject / Edit buttons

  Scenario: Approving resumes execution
    Given the HITL form is displayed
    When the user clicks "Approve"
    Then a POST to /api/workflows/execute/{run_id}/hitl-response should be sent
    And the execution phase should return to "running"
    And the workflow should continue from where it paused

  Scenario: Rejecting stops execution
    Given the HITL form is displayed
    When the user clicks "Reject"
    Then the workflow should stop
    And the execution phase should change to "failed"

Feature: Reasoning Trace Display

  Scenario: LLM node shows reasoning after execution
    Given an LLM node has completed execution
    And the execution included AER (Agent Execution Record) data
    When the user hovers over the completed LLM node
    Then a popover should display showing intent, observation, and inference
```

---

## 5. TDD Test File

### Create: `C:\Users\nsdha\OneDrive\code\benny\tests\test_studio_execution.py`

```python
"""
Test suite for Phase 5 — Studio Execution Streaming & HITL.
Run with: python -m pytest tests/test_studio_execution.py -v
"""

import pytest
import json
from unittest.mock import patch, MagicMock
from fastapi.testclient import TestClient


class TestExecutionSSE:

    def test_emit_event_creates_buffer(self):
        from benny.api.studio_executor import _emit_execution_event, _execution_events
        _execution_events.clear()
        
        _emit_execution_event("run-123", "node_started", {"nodeId": "n1"})
        
        assert "run-123" in _execution_events
        assert len(_execution_events["run-123"]) == 1
        assert _execution_events["run-123"][0]["type"] == "node_started"
        assert _execution_events["run-123"][0]["nodeId"] == "n1"

    def test_multiple_events(self):
        from benny.api.studio_executor import _emit_execution_event, _execution_events
        _execution_events.clear()
        
        _emit_execution_event("run-456", "node_started", {"nodeId": "n1"})
        _emit_execution_event("run-456", "node_completed", {"nodeId": "n1", "output": "done"})
        _emit_execution_event("run-456", "workflow_completed", {"outputs": {}})
        
        assert len(_execution_events["run-456"]) == 3
        types = [e["type"] for e in _execution_events["run-456"]]
        assert types == ["node_started", "node_completed", "workflow_completed"]

    def test_event_has_timestamp(self):
        from benny.api.studio_executor import _emit_execution_event, _execution_events
        _execution_events.clear()
        
        _emit_execution_event("run-789", "node_started", {"nodeId": "n1"})
        assert "timestamp" in _execution_events["run-789"][0]


class TestHITLEndpoint:

    def test_hitl_response_returns_404_for_unknown_run(self):
        from benny.api.server import app
        from benny.api.studio_executor import _execution_events
        _execution_events.clear()
        
        client = TestClient(app)
        response = client.post(
            "/api/workflows/execute/nonexistent/hitl-response",
            json={"decision": "approve"},
            headers={"X-Benny-API-Key": "benny-mesh-2026-auth"},
        )
        assert response.status_code == 404

    def test_hitl_response_accepted_for_valid_run(self):
        from benny.api.server import app
        from benny.api.studio_executor import _execution_events
        _execution_events.clear()
        _execution_events["run-hitl-test"] = []
        
        client = TestClient(app)
        response = client.post(
            "/api/workflows/execute/run-hitl-test/hitl-response",
            json={"decision": "approve"},
            headers={"X-Benny-API-Key": "benny-mesh-2026-auth"},
        )
        assert response.status_code == 200
        assert response.json()["status"] == "received"


class TestSSEEndpoint:

    def test_sse_endpoint_exists(self):
        from benny.api.server import app
        from benny.api.studio_executor import _execution_events, _emit_execution_event
        _execution_events.clear()
        
        # Pre-load a completed execution
        _emit_execution_event("run-sse-test", "workflow_completed", {})
        
        client = TestClient(app)
        response = client.get(
            "/api/workflows/execute/run-sse-test/events",
            headers={"X-Benny-API-Key": "benny-mesh-2026-auth"},
        )
        assert response.status_code == 200
```

---

## 6. Execution Order

1. Read ALL files in Section 2
2. Create `C:\Users\nsdha\OneDrive\code\benny\tests\test_studio_execution.py`
3. Modify `C:\Users\nsdha\OneDrive\code\benny\frontend\src\hooks\useWorkflowStore.ts` — add new state
4. Modify `C:\Users\nsdha\OneDrive\code\benny\benny\api\studio_executor.py` — add SSE + HITL
5. Create `C:\Users\nsdha\OneDrive\code\benny\frontend\src\components\Studio\LiveExecutionOverlay.tsx`
6. Create `C:\Users\nsdha\OneDrive\code\benny\frontend\src\components\Studio\HITLFormPanel.tsx`
7. Create `C:\Users\nsdha\OneDrive\code\benny\frontend\src\components\Studio\ReasoningTracePopover.tsx`
8. Modify `C:\Users\nsdha\OneDrive\code\benny\frontend\src\components\Studio\WorkflowCanvas.tsx`
9. Modify `C:\Users\nsdha\OneDrive\code\benny\frontend\src\components\Studio\ExecutionBar.tsx`
10. Run backend tests: `python -m pytest tests/test_studio_execution.py -v`
11. Start frontend: `cd frontend && npm run dev`
12. Visual verification: execute a workflow and verify SSE events appear

---

## 7. Definition of Done

- [ ] All 5 tests in `test_studio_execution.py` pass
- [ ] SSE endpoint streams node_started/completed/error/workflow_completed events
- [ ] HITL response endpoint accepts approve/reject/edit decisions
- [ ] LiveExecutionOverlay renders phase banner on canvas
- [ ] HITLFormPanel renders with approve/reject/edit buttons when paused
- [ ] ReasoningTracePopover shows AER data on hover
- [ ] Execution phase transitions: idle → running → (paused_hitl) → completed/failed
- [ ] Zustand store tracks all new execution state fields
- [ ] ExecutionBar uses SSE instead of blocking fetch
- [ ] No TypeScript compilation errors
