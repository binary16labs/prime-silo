import { useEffect, useState, useRef } from 'react';
import { useShallow } from 'zustand/react/shallow';
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
    nodes,
    setNodes,
    toggleAuditHub,
    isAuditHubOpen,
    completedTasks,
    totalTasks,
    npuActive,
  } = useWorkflowStore(useShallow((state) => ({
    executionPhase: state.executionPhase,
    executionRunId: state.executionRunId,
    setExecutionPhase: state.setExecutionPhase,
    setCurrentExecutingNodeId: state.setCurrentExecutingNodeId,
    setHitlPendingData: state.setHitlPendingData,
    addExecutionEvent: state.addExecutionEvent,
    setReasoningTrace: state.setReasoningTrace,
    startNodeTimer: state.startNodeTimer,
    stopNodeTimer: state.stopNodeTimer,
    nodes: state.nodes,
    setNodes: state.setNodes,
    toggleAuditHub: state.toggleAuditHub,
    isAuditHubOpen: state.isAuditHubOpen,
    completedTasks: state.completedTasks,
    totalTasks: state.totalTasks,
    npuActive: state.npuActive,
  })));
  
  const eventSourceRef = useRef<EventSource | null>(null);

  // Connect to SSE when execution starts
  useEffect(() => {
    if (executionPhase !== 'running' || !executionRunId) {
      console.log('[AUDIT] SSE useEffect early return | phase:', executionPhase, '| runId:', executionRunId);
      return;
    }

    const url = `${API_BASE_URL}/api/workflows/execute/${executionRunId}/events`;
    console.log('[AUDIT] Connecting to SSE | url:', url);
    const eventSource = new EventSource(url);
    eventSourceRef.current = eventSource;
    console.log('[AUDIT] EventSource created for:', executionRunId);

    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        console.log('[AUDIT] SSE message received | type:', data.type, '| nodeId:', data.nodeId);
        
        if (data.type === 'heartbeat') {
          console.log('[AUDIT] Heartbeat received');
          return;
        }

        addExecutionEvent({
          type: data.type,
          nodeId: data.nodeId,
          timestamp: Date.now(),
          data,
        });

        switch (data.type) {
          case 'node_started':
            console.log('[AUDIT] Node started:', data.nodeId);
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
            console.log('[AUDIT] Node completed:', data.nodeId);
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
            console.log('[AUDIT] Node error:', data.nodeId, '| error:', data.error);
            stopNodeTimer(data.nodeId);
            setNodes(nodes.map(n =>
              n.id === data.nodeId
                ? { ...n, data: { ...n.data, status: 'error', executionOutput: data.error } }
                : n
            ));
            break;

          case 'node_progress':
            console.log('[AUDIT] Node progress:', data.nodeId, '| message:', data.message);
            // Update reasoning trace in real-time if provided
            if (data.reasoning || data.inference) {
              const trace = data.reasoning || {
                intent: data.message || '',
                observation: '',
                inference: data.inference || '',
                plan: ''
              };
              setReasoningTrace(data.nodeId, trace);
            }
            
            // Optionally update node status data with the progress message
            if (data.message) {
              setNodes(nodes.map(n =>
                n.id === data.nodeId
                  ? { ...n, data: { ...n.data, statusMessage: data.message } }
                  : n
              ));
            }
            break;

          case 'hitl_required':
            console.log('[AUDIT] HITL required');
            setHitlPendingData({
              nodeId: data.nodeId,
              nodeName: data.nodeName || 'Intervention',
              action_description: data.action_description || '',
              reasoning: data.reasoning || '',
              current_state_summary: data.current_state_summary || '',
              options: data.options || [
                { label: 'Approve', value: 'approve' },
                { label: 'Reject', value: 'reject' },
              ],
            });
            break;

          case 'tool_used':
            console.log('[AUDIT] Tool used:', data.tool_name, '| node:', data.nodeId);
            // Tool usage is also piped as reasoning, but we can store it specifically if needed
            break;

          case 'resource_usage':
            console.log('[AUDIT] Resource usage:', data.model, '| tokens:', data.usage?.total_tokens);
            break;

          case 'workflow_completed':
            console.log('[AUDIT] Workflow completed');
            setExecutionPhase('completed');
            setCurrentExecutingNodeId(null);
            // Keep completed for longer if hub is open
            setTimeout(() => setExecutionPhase('idle'), 5000);
            break;

          case 'workflow_failed':
            console.log('[AUDIT] Workflow failed');
            setExecutionPhase('failed');
            setCurrentExecutingNodeId(null);
            break;
        }
      } catch (e) {
        console.error('[AUDIT] SSE parse error:', e);
      }
    };

    eventSource.onerror = () => {
      console.warn('[AUDIT] SSE connection lost for:', executionRunId);
      eventSource.close();
    };

    return () => {
      console.log('[AUDIT] Closing SSE connection for:', executionRunId);
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
          color: '#fff',
          backdropFilter: 'blur(8px)',
          boxShadow: npuActive ? '0 0 20px rgba(139, 92, 246, 0.4)' : 'none',
          transition: 'all 0.3s ease',
        }}>
          {executionPhase === 'running' && (
            <span className={npuActive ? "animate-bounce" : "animate-pulse"} style={{ 
              width: 8, 
              height: 8, 
              borderRadius: '50%', 
              background: npuActive ? '#10b981' : '#8b5cf6', 
              display: 'inline-block',
              boxShadow: npuActive ? '0 0 10px #10b981' : 'none'
            }} />
          )}
          {executionPhase === 'running' ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span>{npuActive ? '🚀 NPU ACTIVE' : '⚡ EXECUTING'}</span>
              {totalTasks > 0 && (
                <span style={{ opacity: 0.6, fontSize: '10px' }}>
                  [{completedTasks}/{totalTasks}]
                </span>
              )}
            </div>
          )
            : executionPhase === 'paused_hitl' ? '⏸ Waiting for Approval'
            : executionPhase === 'completed' ? '✅ Completed'
            : '❌ Failed'}
          
          <div style={{ width: '1px', height: '16px', background: 'rgba(255,255,255,0.2)', margin: '0 4px' }} />
          
          <button 
            onClick={toggleAuditHub}
            style={{
              background: 'none',
              border: 'none',
              color: isAuditHubOpen ? '#8b5cf6' : '#fff',
              fontSize: '11px',
              fontWeight: 600,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
              padding: '2px 4px',
              transition: 'all 0.2s',
            }}
          >
            {isAuditHubOpen ? '✕ Close Audit' : '📜 View Audit'}
          </button>
        </div>
      </div>
    </div>
  );
}
