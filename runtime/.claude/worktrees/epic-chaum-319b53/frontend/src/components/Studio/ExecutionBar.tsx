import { useState, useEffect } from 'react';
import { Play, RotateCcw, Save, Loader, Zap, ShieldCheck, ShieldAlert, Shield } from 'lucide-react';
import { useWorkflowStore } from '../../hooks/useWorkflowStore';
import { useWorkspaceStore } from '../../hooks/useWorkspaceStore';
import WorkflowExportImport from './WorkflowExportImport';
import ActiveLLMBadge from './ActiveLLMBadge';
import { API_BASE_URL, GOVERNANCE_HEADERS } from '../../constants';

interface ExecutionBarProps {
  onNavigateToLLM?: () => void;
}

function useAuditVerification(executionId: string | null) {
  const [status, setStatus] = useState<'pending' | 'verified' | 'tampered'>('pending');
  const [verifiedCount, setVerifiedCount] = useState(0);

  useEffect(() => {
    if (!executionId) return;

    const verify = async () => {
      try {
        const response = await fetch(`${API_BASE_URL}/api/governance/verify-audit/${executionId}`, {
          headers: GOVERNANCE_HEADERS
        });
        if (response.ok) {
          const data = await response.json();
          setStatus(data.is_valid ? 'verified' : 'tampered');
          setVerifiedCount(data.event_count || 0);
        } else {
          setStatus('tampered');
        }
      } catch (err) {
        setStatus('tampered');
      }
    };

    const interval = setInterval(verify, 5000);
    verify();
    return () => clearInterval(interval);
  }, [executionId]);

  return { status, verifiedCount };
}

const TrustBar = ({ executionId }: { executionId: string | null }) => {
  const { status, verifiedCount } = useAuditVerification(executionId);
  
  if (!executionId) return null;

  return (
    <div className={`trust-bar status-${status}`} style={{
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      padding: '4px 12px',
      borderRadius: '20px',
      fontSize: '12px',
      fontWeight: '600',
      background: status === 'verified' ? 'rgba(76, 175, 80, 0.1)' : status === 'tampered' ? 'rgba(244, 67, 54, 0.1)' : 'rgba(158, 158, 158, 0.1)',
      color: status === 'verified' ? '#4caf50' : status === 'tampered' ? '#f44336' : '#9e9e9e',
      border: `1px solid ${status === 'verified' ? '#4caf50' : status === 'tampered' ? '#f44336' : '#9e9e9e'}`,
      marginLeft: '16px'
    }}>
      {status === 'verified' ? <ShieldCheck size={14} /> : status === 'tampered' ? <ShieldAlert size={14} /> : <Shield size={14} />}
      {status === 'verified' ? `${verifiedCount} Events Verified` : status === 'tampered' ? 'Integrity Compromised' : 'Verifying...'}
    </div>
  );
}

export default function ExecutionBar({ onNavigateToLLM }: ExecutionBarProps) {
  const { currentWorkspace, activeLLMProvider, activeLLMModels } = useWorkspaceStore();
  const {
    clearExecution,
    resetExecution,
    setExecutionPhase,
    setExecutionRunId,
    nodes,
    edges,
    setNodes,
    setSwarmExecutionId,
    executionRunId,
    swarmExecutionId,
    currentWorkflow,
    toggleAuditHub,
    isAuditHubOpen,
  } = useWorkflowStore();

  const [saving, setSaving] = useState(false);
  const [executing, setExecuting] = useState(false);
  // Default to the active model from LLM Management
  const activeModel = activeLLMModels[activeLLMProvider] || 'Qwen3-8B-Hybrid';
  const [swarmConfig, setSwarmConfig] = useState({
    model: activeModel,
    max_concurrency: 1,
    workspace: currentWorkspace
  });
  const [pauseBetweenWaves, setPauseBetweenWaves] = useState(false);
  
  const handleExecute = async () => {
    if (nodes.length === 0) {
      alert('Please add nodes to your workflow first');
      return;
    }

    // Check if workflow has a trigger node — prompt for message
    const hasTrigger = nodes.some(n => n.type === 'trigger');
    let message = '';
    if (hasTrigger) {
      const prompted = prompt(
        'Enter your message for this workflow:',
        'Tell me how I should consider AI when looking at the frolov document'
      );
      if (prompted === null) return; // cancelled
      message = prompted;
    }
    
    // 1. Reset store execution state
    resetExecution();
    setExecuting(true);
    console.log('[AUDIT] Starting workflow execution | workspace:', currentWorkspace, '| nodes:', nodes.length, '| message:', message.substring(0, 50));

    try {
      console.log('[AUDIT] Sending request to /api/workflows/execute');
      const response = await fetch(`${API_BASE_URL}/api/workflows/execute`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          ...GOVERNANCE_HEADERS
        },
        body: JSON.stringify({ 
          nodes, 
          edges,
          workspace: currentWorkspace,
          message
        })
      });
      
      console.log('[AUDIT] Response received | status:', response.status, '| ok:', response.ok);
      
      if (response.ok) {
        const result = await response.json();
        console.log('[AUDIT] Response parsed | result:', result);
        console.log('[AUDIT] Setting execution runId:', result.run_id);

        // 2. Set Run ID and Phase to trigger LiveExecutionOverlay (SSE)
        setExecutionRunId(result.run_id);
        setExecutionPhase('running');
        console.log('[AUDIT] Execution phase set to running with runId:', result.run_id);
        
        // Note: The LiveExecutionOverlay handles all node updates via SSE
      } else {
        const errText = await response.text();
        console.error('[AUDIT] Execution failed | status:', response.status, '| error:', errText);
        alert('Execution failed to start: ' + errText);
        setExecutionPhase('failed');
      }
    } catch (error) {
      console.error('[AUDIT] Execution setup error:', error);
      alert('Execution failed to start: ' + (error as Error).message);
      setExecutionPhase('failed');
    } finally {
      setExecuting(false);
    }
  };

  const handleSwarmExecute = async () => {
    const defaultPrompt = currentWorkflow?.type === 'strategy' 
      ? currentWorkflow.trigger?.prompt 
      : 'Create a comprehensive guide on...';
      
    const request = prompt('Enter your swarm request:', defaultPrompt);
    if (!request) return;
    
    console.log('[AUDIT] Starting swarm execution | workflow:', currentWorkflow?.id, '| workspace:', currentWorkspace, '| message:', request.substring(0, 50));
    setExecuting(true);
    try {
      console.log('[AUDIT] Sending request to /api/workflow/execute');
      const response = await fetch(`${API_BASE_URL}/api/workflow/execute`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          ...GOVERNANCE_HEADERS
        },
        body: JSON.stringify({ 
          workflow: currentWorkflow?.id || 'swarm',
          workspace: currentWorkspace,
          message: request,
          model: swarmConfig.model,
          params: {
            max_concurrency: swarmConfig.max_concurrency,
            pause_between_waves: pauseBetweenWaves
          }
        })
      });
      
      console.log('[AUDIT] Response received | status:', response.status, '| ok:', response.ok);
      
      if (response.ok) {
        const result = await response.json();
        console.log('[AUDIT] Response parsed | execution_id:', result.execution_id, '| status:', result.status);
        setSwarmExecutionId(result.execution_id);
        
        const { setNodes, setEdges } = useWorkflowStore.getState();
        if (currentWorkflow && currentWorkflow.nodes && currentWorkflow.nodes.length > 0) {
          setNodes(currentWorkflow.nodes);
          setEdges(currentWorkflow.edges || []);
        } else {
          // Fallback to minimal core mesh if no declarative nodes found
          const swarmNodes = [
            { id: 'planner', type: 'llm', position: { x: 250, y: 50 }, data: { label: 'Planner (Bricoleur)', config: { model: swarmConfig.model } } },
            { id: 'wave_scheduler', type: 'logic', position: { x: 250, y: 150 }, data: { label: 'Wave Scheduler', config: { operation: 'Topological Sort' } } },
            { id: 'orchestrator', type: 'logic', position: { x: 250, y: 250 }, data: { label: 'Orchestrator', config: { condition: 'Review Plan' } } },
            { id: 'dispatcher', type: 'trigger', position: { x: 250, y: 350 }, data: { label: 'Dispatcher', config: { type: 'fan-out' } } },
            { id: 'executor', type: 'tool', position: { x: 250, y: 450 }, data: { label: `Executor (x${swarmConfig.max_concurrency})`, config: { tool: 'code_execution' } } },
            { id: 'aggregator', type: 'data', position: { x: 250, y: 650 }, data: { label: 'Aggregator (Kludge)', config: { operation: 'combine' } } }
          ];

          const swarmEdges = [
            { id: 'e1', source: 'planner', target: 'wave_scheduler', animated: true },
            { id: 'e2', source: 'wave_scheduler', target: 'orchestrator', animated: true },
            { id: 'e3', source: 'orchestrator', target: 'dispatcher', animated: true },
            { id: 'e4', source: 'dispatcher', target: 'executor', animated: true },
            { id: 'e8', source: 'executor', target: 'aggregator', animated: true }
          ];
          setNodes(swarmNodes);
          setEdges(swarmEdges);
        }

        console.log('Swarm started:', result);
        // Link to real-time UI
        setExecutionRunId(result.execution_id);
        setExecutionPhase('running');
      } else {
        alert('Swarm execution failed');
      }
    } catch (error) {
      console.error('Swarm error:', error);
      alert('Swarm failed: ' + (error as Error).message);
    } finally {
      setExecuting(false);
    }
  };

  const handleSave = async () => {
    if (nodes.length === 0) {
      alert('Cannot save empty workflow');
      return;
    }
    
    const name = prompt('Workflow name:', 'Untitled Workflow');
    if (!name) return;
    
    setSaving(true);
    try {
      const response = await fetch(`${API_BASE_URL}/api/workflows`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          ...GOVERNANCE_HEADERS
        },
        body: JSON.stringify({
          name,
          description: '',
          nodes,
          edges,
          type: 'user'
        })
      });
      
      if (response.ok) {
        alert('Workflow saved successfully!');
      } else {
        alert('Save failed');
      }
    } catch (error) {
      console.error('Save error:', error);
      alert('Save failed: ' + (error as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="top-bar">
      <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
        <h1>🔷 Workflow Studio</h1>
        <ActiveLLMBadge onNavigateToLLM={onNavigateToLLM} />
        <TrustBar executionId={swarmExecutionId || executionRunId} />
      </div>
      
      <div className="execution-controls">
        <button 
          className="btn btn-gradient" 
          onClick={handleExecute}
          disabled={executing || nodes.length === 0}
        >
          {executing ? <Loader className="animate-spin" size={16} /> : <Play size={16} />}
          {executing ? 'Executing...' : 'Execute'}
        </button>
        <button className="btn btn-outline" onClick={clearExecution}>
          <RotateCcw size={16} />
          Clear
        </button>
        <button 
          className="btn btn-outline" 
          onClick={handleSave}
          disabled={saving || nodes.length === 0}
        >
          {saving ? <Loader className="animate-spin" size={16} /> : <Save size={16} />}
          {saving ? 'Saving...' : 'Save'}
        </button>

        <button 
          className={`btn btn-outline ${isAuditHubOpen ? 'active' : ''}`}
          onClick={toggleAuditHub}
          style={{ borderColor: isAuditHubOpen ? 'var(--primary)' : 'var(--border-color)', color: isAuditHubOpen ? 'var(--primary)' : 'inherit' }}
        >
          <Shield size={16} />
          Logs
        </button>
        
        <div style={{ marginLeft: '8px', borderLeft: '1px solid var(--border-color)', paddingLeft: '16px', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: 'var(--text-tertiary)', whiteSpace: 'nowrap', cursor: 'pointer' }}>
            <input 
              type="checkbox" 
              checked={pauseBetweenWaves} 
              onChange={(e) => setPauseBetweenWaves(e.target.checked)}
              style={{ cursor: 'pointer' }}
            />
            Pause between waves
          </label>
          <button 
            className="btn btn-gradient" 
            onClick={handleSwarmExecute}
            disabled={executing}
            title="Execute a Swarm workflow"
          >
            <Zap size={16} />
            {currentWorkflow?.type === 'strategy' ? currentWorkflow.name : 'Swarm'}
          </button>
        </div>
        
        <WorkflowExportImport 
          workflowName="workflow"
          config={swarmConfig}
          onConfigChange={setSwarmConfig}
        />
      </div>
    </div>
  );
}
