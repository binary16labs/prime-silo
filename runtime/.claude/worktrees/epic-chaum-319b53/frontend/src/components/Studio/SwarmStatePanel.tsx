import { useState, useEffect } from 'react';
import { RefreshCw, CheckCircle2, XCircle, Clock, Loader2, ExternalLink, Copy, Brain, Target, Search, Lightbulb, ClipboardList } from 'lucide-react';
import { API_BASE_URL, GOVERNANCE_HEADERS } from '../../constants';
import WaveTimeline from './WaveTimeline';

interface TaskItem {
  task_id: string;
  description: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  skill_hint?: string;
}

interface PartialResult {
  task_id: string;
  content?: string;
  error?: string;
  execution_time_ms: number;
}

interface SwarmExecutionState {
  execution_id: string;
  status: 'pending' | 'planning' | 'executing' | 'aggregating' | 'completed' | 'partial_success' | 'failed' | 'scheduled';
  plan?: TaskItem[];
  partial_results?: PartialResult[];
  artifact_path?: string;
  governance_url?: string;
  errors?: string[];
  // === NEW FIELDS ===
  waves?: string[][];
  current_wave?: number;
  ascii_dag?: string;
  review_pass_results?: Array<{ type: string; severity: string; message: string }>;
  aer_log?: Array<{ timestamp: string; intent: string; observation: string; inference?: string; plan?: string }>;
}

interface SwarmStatePanelProps {
  executionId: string | null;
}

const API_BASE = API_BASE_URL;

export default function SwarmStatePanel({ executionId }: SwarmStatePanelProps) {
  const [state, setState] = useState<SwarmExecutionState | null>(null);
  const [loading, setLoading] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);

  const fetchState = async () => {
    if (!executionId) return;
    
    setLoading(true);
    try {
      const response = await fetch(`${API_BASE}/api/workflow/${executionId}/status`, {
        headers: { ...GOVERNANCE_HEADERS }
      });
      if (response.ok) {
        const data = await response.json();
        setState(data);
        
        // Stop auto-refresh if completed
        if (['completed', 'partial_success', 'failed'].includes(data.status)) {
          setAutoRefresh(false);
        }
      }
    } catch (error) {
      console.error('Failed to fetch swarm state:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (executionId) {
      fetchState();
    }
  }, [executionId]);

  useEffect(() => {
    if (!autoRefresh || !executionId) return;
    
    const interval = setInterval(fetchState, 2000);
    return () => clearInterval(interval);
  }, [autoRefresh, executionId]);

  if (!executionId) {
    return (
      <div className="swarm-state-panel empty">
        <div className="empty-state">
          <Clock size={32} />
          <p>No active swarm execution</p>
          <span>Execute a swarm workflow to see live state</span>
        </div>
      </div>
    );
  }

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'completed':
        return <CheckCircle2 size={16} className="status-success" />;
      case 'failed':
        return <XCircle size={16} className="status-error" />;
      case 'running':
      case 'planning':
      case 'executing':
      case 'aggregating':
        return <Loader2 size={16} className="status-running spin" />;
      default:
        return <Clock size={16} className="status-pending" />;
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'completed': return 'var(--success)';
      case 'partial_success': return 'var(--warning)';
      case 'failed': return 'var(--error)';
      case 'running':
      case 'planning':
      case 'executing':
      case 'aggregating':
        return 'var(--primary)';
      default: return 'var(--text-secondary)';
    }
  };

  const completedCount = state?.partial_results?.filter(r => r.content && !r.error).length || 0;
  const failedCount = state?.partial_results?.filter(r => r.error).length || 0;
  const totalTasks = state?.plan?.length || 0;

  return (
    <div className="swarm-state-panel">
      <div className="swarm-state-header">
        <h3>Swarm Execution</h3>
        <div className="swarm-state-actions">
          <button 
            className="btn btn-icon btn-ghost"
            onClick={fetchState}
            disabled={loading}
            title="Refresh"
          >
            <RefreshCw size={16} className={loading ? 'spin' : ''} />
          </button>
        </div>
      </div>

      {/* Status Bar */}
      <div className="swarm-status-bar" style={{ borderLeftColor: getStatusColor(state?.status || 'pending') }}>
        <div className="swarm-status-icon">
          {getStatusIcon(state?.status || 'pending')}
        </div>
        <div className="swarm-status-info">
          <span className="swarm-status-label">{state?.status?.toUpperCase() || 'PENDING'}</span>
          <div className="swarm-status-id-row">
            <span className="swarm-status-id">{executionId.slice(0, 8)}...</span>
            <button 
              className="btn btn-icon btn-ghost btn-xs"
              onClick={() => {
                navigator.clipboard.writeText(executionId);
                alert('Execution ID copied!');
              }}
              title="Copy full execution ID"
            >
              <Copy size={12} />
            </button>
          </div>
        </div>
      </div>

      {/* Waves Visualization */}
      {state?.waves && state.waves.length > 0 && (
        <WaveTimeline 
          waves={state.waves}
          tasks={(state.plan || []).map(t => {
            const res = state.partial_results?.find(r => r.task_id === t.task_id);
            return {
              task_id: t.task_id,
              description: t.description,
              status: res?.error ? 'failed' : res?.content ? 'completed' : (t.status as any),
              wave: 0
            };
          })}
          currentWave={state.current_wave || 0}
          asciiDag={state.ascii_dag}
          reviewFindings={state.review_pass_results}
        />
      )}

      {/* Progress */}
      {totalTasks > 0 && !state?.waves && (
        <div className="swarm-progress">
          <div className="swarm-progress-header">
            <span>Tasks</span>
            <span>{completedCount + failedCount} / {totalTasks}</span>
          </div>
          <div className="swarm-progress-bar">
            <div 
              className="swarm-progress-fill success"
              style={{ width: `${(completedCount / totalTasks) * 100}%` }}
            />
            <div 
              className="swarm-progress-fill error"
              style={{ width: `${(failedCount / totalTasks) * 100}%` }}
            />
          </div>
        </div>
      )}

      {/* Task List */}
      {state?.plan && state.plan.length > 0 && (
        <div className="swarm-tasks">
          <div className="swarm-tasks-header">Plan</div>
          <div className="swarm-tasks-list">
            {state.plan.map((task, index) => {
              const result = state.partial_results?.find(r => r.task_id === task.task_id);
              const taskStatus = result?.error ? 'failed' : result?.content ? 'completed' : task.status;
              
              return (
                <div key={task.task_id} className={`swarm-task-item ${taskStatus}`}>
                  <div className="swarm-task-index">{index + 1}</div>
                  <div className="swarm-task-content">
                    <div className="swarm-task-description">
                      {task.description.slice(0, 60)}...
                    </div>
                    {result?.execution_time_ms && (
                      <div className="swarm-task-time">
                        {(result.execution_time_ms / 1000).toFixed(1)}s
                      </div>
                    )}
                  </div>
                  <div className="swarm-task-status">
                    {getStatusIcon(taskStatus)}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Synthesis Narrative Feed */}
      {state?.aer_log && state.aer_log.length > 0 && (
        <div className="synthesis-narrative" style={{ marginTop: '24px', borderTop: '1px solid var(--border-color)', paddingTop: '24px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px' }}>
            <Brain size={18} style={{ color: 'var(--primary)' }} />
            <h3 style={{ margin: 0, fontSize: '14px', textTransform: 'uppercase', letterSpacing: '0.1em' }}>Synthesis Narrative</h3>
          </div>
          <div style={{ 
            display: 'flex', 
            flexDirection: 'column', 
            gap: '20px',
            maxHeight: '500px',
            overflowY: 'auto',
            paddingRight: '8px',
            scrollBehavior: 'smooth'
          }} className="narrative-feed custom-scrollbar">
            {state.aer_log.map((entry, i) => (
              <div key={i} className="narrative-entry" style={{
                position: 'relative',
                paddingLeft: '24px',
                borderLeft: '2px solid rgba(168, 139, 250, 0.2)',
                animation: 'fadeIn 0.5s ease-out'
              }}>
                <div style={{
                  position: 'absolute',
                  left: '-9px',
                  top: '0',
                  width: '16px',
                  height: '16px',
                  borderRadius: '50%',
                  background: 'var(--surface)',
                  border: '2px solid var(--primary)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center'
                }}>
                   <div style={{ width: '6px', height: '6px', borderRadius: '50%', background: 'var(--primary)' }} />
                </div>
                
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                  <Target size={12} style={{ color: '#8b5cf6' }} />
                  <span style={{ fontSize: '11px', fontWeight: 'bold', color: '#8b5cf6', textTransform: 'uppercase' }}>{entry.intent}</span>
                  <span style={{ fontSize: '10px', color: 'var(--text-muted)', marginLeft: 'auto' }}>
                    {new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                  </span>
                </div>

                <div style={{ fontSize: '13px', lineHeight: '1.6', color: 'var(--text-primary)', background: 'rgba(255,255,255,0.03)', padding: '12px', borderRadius: '8px' }}>
                   {entry.observation}
                </div>

                {(entry.inference || entry.plan) && (
                  <div style={{ marginTop: '12px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                     {entry.inference && (
                        <div style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>
                           <div style={{ display: 'flex', alignItems: 'center', gap: '4px', color: '#eab308', fontWeight: 'bold', marginBottom: '4px', textTransform: 'uppercase' }}>
                             <Lightbulb size={12} /> Inference
                           </div>
                           {entry.inference}
                        </div>
                     )}
                     {entry.plan && (
                        <div style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>
                           <div style={{ display: 'flex', alignItems: 'center', gap: '4px', color: '#22c55e', fontWeight: 'bold', marginBottom: '4px', textTransform: 'uppercase' }}>
                             <ClipboardList size={12} /> Next Step
                           </div>
                           {entry.plan}
                        </div>
                     )}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Errors */}
      {state?.errors && state.errors.length > 0 && (
        <div className="swarm-errors">
          <div className="swarm-errors-header">Errors</div>
          {state.errors.map((error, i) => (
            <div key={i} className="swarm-error-item">{error}</div>
          ))}
        </div>
      )}

      {/* Governance Link */}
      {state?.governance_url && (
        <div className="swarm-governance-row">
          <a 
            href={state.governance_url} 
            target="_blank" 
            rel="noopener noreferrer"
            className="swarm-governance-link"
          >
            <ExternalLink size={14} />
            View in Marquez
          </a>
          <button 
            className="btn btn-icon btn-ghost btn-sm"
            onClick={() => {
              navigator.clipboard.writeText(state.governance_url!);
              alert('Governance URL copied!');
            }}
            title="Copy governance URL"
          >
            <Copy size={14} />
          </button>
        </div>
      )}

      {/* Artifact Link */}
      {state?.artifact_path && (
        <div className="swarm-artifact">
          <span className="swarm-artifact-label">Output:</span>
          <span className="swarm-artifact-path">{state.artifact_path.split('/').pop()}</span>
        </div>
      )}
    </div>
  );
}
