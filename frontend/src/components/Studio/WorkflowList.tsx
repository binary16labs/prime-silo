import { useState, useEffect, useRef } from 'react';
import { FileText, Plus, Trash2, Loader, Zap, History, PlayCircle, CheckCircle2, XCircle, Clock, Upload } from 'lucide-react';
import { useWorkflowStore } from '../../hooks/useWorkflowStore';
import { useWorkspaceStore } from '../../hooks/useWorkspaceStore';
import { API_BASE_URL, GOVERNANCE_HEADERS } from '../../constants';

interface Workflow {
  id: string;
  name: string;
  description?: string;
  type: 'user' | 'example' | 'strategy';
  readonly?: boolean;
  nodes: any[];
  edges: any[];
}

interface WorkflowListProps {
  mode?: 'flows' | 'agents' | 'runs';
}

export default function WorkflowList({ mode: initialMode = 'flows' }: WorkflowListProps) {
  const [mode, setMode] = useState(initialMode);
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [runs, setRuns] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  
  const setNodes = useWorkflowStore((state) => state.setNodes);
  const setEdges = useWorkflowStore((state) => state.setEdges);
  const setCurrentWorkflow = useWorkflowStore((state) => state.setCurrentWorkflow);
  const { currentWorkspace } = useWorkspaceStore();

  useEffect(() => {
    if (mode === 'runs') {
      fetchRuns();
    } else {
      fetchWorkflows();
    }
  }, [mode, currentWorkspace]);

  const fetchWorkflows = async () => {
    setLoading(true);
    try {
      const response = await fetch(`${API_BASE_URL}/api/workflows`, {
        headers: { ...GOVERNANCE_HEADERS }
      });
      const data = await response.json();
      const workflowList = Array.isArray(data) ? data : (data.workflows || []);
      setWorkflows(workflowList);
    } catch (error) {
      console.error('Failed to fetch workflows:', error);
    } finally {
      setLoading(false);
    }
  };

  const fetchRuns = async () => {
    setLoading(true);
    try {
      const response = await fetch(`${API_BASE_URL}/api/tasks?workspace=${currentWorkspace}`, {
        headers: { ...GOVERNANCE_HEADERS }
      });
      const data = await response.json();
      // Sort by updated_at desc
      const runList = Array.isArray(data) ? data : [];
      runList.sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());
      setRuns(runList);
    } catch (error) {
      console.error('Failed to fetch runs:', error);
    } finally {
      setLoading(false);
    }
  };

  const filteredWorkflows = workflows.filter(w => {
    const isStrategy = w.type === 'strategy';
    const isAgent = w.name.toLowerCase().includes('agent') || w.name.toLowerCase().includes('persona') || isStrategy;
    return mode === 'agents' ? isAgent : !isAgent;
  });

  const loadWorkflow = async (workflow: Workflow) => {
    setSelectedId(workflow.id);
    setNodes(workflow.nodes || []);
    setEdges(workflow.edges || []);
    setCurrentWorkflow(workflow);
  };

  const deleteWorkflow = async (id: string) => {
    if (!confirm('Delete this workflow?')) return;
    try {
      await fetch(`${API_BASE_URL}/api/workflows/${id}`, {
        method: 'DELETE',
        headers: { ...GOVERNANCE_HEADERS }
      });
      fetchWorkflows();
    } catch (error) {
      console.error('Failed to delete workflow:', error);
    }
  };

  const formatDate = (iso: string) => {
    try {
      const date = new Date(iso);
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + ' ' + date.toLocaleDateString([], { month: 'short', day: 'numeric' });
    } catch {
      return iso;
    }
  }

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'running': return <PlayCircle size={16} className="animate-pulse" style={{ color: 'var(--accent-primary)' }} />;
      case 'completed': return <CheckCircle2 size={16} style={{ color: 'var(--accent-success)' }} />;
      case 'failed': return <XCircle size={16} style={{ color: 'var(--accent-error)' }} />;
      default: return <Clock size={16} style={{ color: 'var(--text-muted)' }} />;
    }
  }

  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleImport = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const data = JSON.parse(e.target?.result as string);
        
        // Ensure it has an ID
        if (!data.id) {
          data.id = `imported_${Date.now()}`;
        }
        if (!data.name) {
          data.name = file.name.replace('.json', '');
        }

        const response = await fetch(`${API_BASE_URL}/api/workflows`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(GOVERNANCE_HEADERS as any)
          },
          body: JSON.stringify(data)
        });

        if (response.ok) {
          alert('Manifest imported successfully!');
          fetchWorkflows();
        } else {
          try {
            const errorData = await response.json();
            alert(`Failed to import: ${errorData.detail || 'Unknown error'}`);
          } catch {
            alert('Failed to import manifest. Server returned an error.');
          }
        }
      } catch (error) {
        alert('Failed to parse file. Please ensure it is valid JSON.');
        console.error('Import error:', error);
      }
    };
    reader.readAsText(file);
    if (event.target) event.target.value = '';
  };

  return (
    <div className="workflow-sidebar-content" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Hidden file input for import */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".json"
        onChange={handleImport}
        style={{ display: 'none' }}
      />
      {/* Sub-tabs for the sidebar section (Pinned) */}
      <div style={{ display: 'flex', padding: '8px 16px', gap: '4px', borderBottom: '1px solid var(--border-color)', background: 'var(--bg-panel-v2)', zIndex: 20 }}>
        <button 
          className={`tab-btn ${mode === 'flows' ? 'active' : ''}`}
          onClick={() => setMode('flows')}
          style={{ flex: 1, padding: '6px', fontSize: '11px', borderRadius: '4px', border: 'none', background: mode === 'flows' ? 'var(--bg-card)' : 'transparent', color: mode === 'flows' ? 'var(--text-primary)' : 'var(--text-muted)', cursor: 'pointer' }}
        >
          Flows
        </button>
        <button 
          className={`tab-btn ${mode === 'agents' ? 'active' : ''}`}
          onClick={() => setMode('agents')}
          style={{ flex: 1, padding: '6px', fontSize: '11px', borderRadius: '4px', border: 'none', background: mode === 'agents' ? 'var(--bg-card)' : 'transparent', color: mode === 'agents' ? 'var(--text-primary)' : 'var(--text-muted)', cursor: 'pointer' }}
        >
          Agents
        </button>
        <button 
          className={`tab-btn ${mode === 'runs' ? 'active' : ''}`}
          onClick={() => setMode('runs')}
          style={{ flex: 1, padding: '6px', fontSize: '11px', borderRadius: '4px', border: 'none', background: mode === 'runs' ? 'var(--bg-card)' : 'transparent', color: mode === 'runs' ? 'var(--text-primary)' : 'var(--text-muted)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px' }}
        >
          <History size={12} />
          Runs
        </button>
      </div>

      {/* Main Action Buttons (Pinned) */}
      {mode !== 'runs' && (
        <div style={{ padding: '16px 16px 8px 16px', display: 'flex', flexDirection: 'column', gap: '8px', borderBottom: '1px solid var(--border-color)', background: 'var(--bg-panel-v2)', zIndex: 10 }}>
          <button
            className="btn btn-gradient"
            onClick={() => { setSelectedId(null); setNodes([]); setEdges([]); }}
            style={{ width: '100%', gap: '8px' }}
          >
            <Plus size={16} />
            {mode === 'agents' ? 'Create New Agent' : 'New Workflow'}
          </button>
          <button
            className="btn btn-outline"
            onClick={() => fileInputRef.current?.click()}
            style={{ width: '100%', gap: '8px' }}
          >
            <Upload size={16} />
            Import {mode === 'agents' ? 'Agent' : 'Manifest'}
          </button>
        </div>
      )}

      <div className="workflow-list-container" style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px', overflowY: 'auto', flex: 1 }}>


        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {loading ? (
             <div style={{ padding: '20px', textAlign: 'center' }}>
               <Loader className="animate-spin" size={24} />
             </div>
          ) : mode === 'runs' ? (
            runs.length === 0 ? (
              <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px' }}>
                No runs recorded in this workspace.
              </div>
            ) : (
              runs.map((run) => (
                <div
                  key={run.task_id}
                  className="run-card"
                  style={{
                    padding: '12px',
                    background: 'var(--bg-card)',
                    borderRadius: '8px',
                    border: '1px solid var(--border-color)',
                    transition: 'all 0.2s ease',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '4px'
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      {getStatusIcon(run.status)}
                      <span style={{ fontSize: '13px', fontWeight: '600' }}>{run.type.toUpperCase()}</span>
                    </div>
                    <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>{formatDate(run.updated_at)}</span>
                  </div>
                  <div style={{ fontSize: '12px', color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {run.message || 'No message'}
                  </div>
                  {run.status === 'running' && (
                    <div style={{ height: '4px', background: 'rgba(255,255,255,0.1)', borderRadius: '2px', marginTop: '4px', overflow: 'hidden' }}>
                      <div style={{ height: '100%', width: `${run.progress}%`, background: 'var(--gradient-primary)', transition: 'width 0.3s ease' }} />
                    </div>
                  )}
                </div>
              ))
            )
          ) : (
            filteredWorkflows.length === 0 ? (
              <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px' }}>
                No {mode === 'agents' ? 'Agents' : 'Flows'} found.
              </div>
            ) : (
              filteredWorkflows.map((workflow) => (
                <div
                  key={workflow.id}
                  className={`workflow-card ${selectedId === workflow.id ? 'selected' : ''}`}
                  onClick={() => loadWorkflow(workflow)}
                  style={{
                    padding: '12px',
                    background: 'var(--bg-card)',
                    borderRadius: '8px',
                    cursor: 'pointer',
                    border: selectedId === workflow.id ? '2px solid var(--accent-llm)' : '1px solid var(--border-color)',
                    transition: 'all 0.2s ease'
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flex: 1 }}>
                      {workflow.type === 'strategy' ? <Zap size={16} style={{ color: 'var(--accent-success)' }} /> : mode === 'agents' ? <Plus size={16} style={{ color: 'var(--accent-llm)' }} /> : <FileText size={16} style={{ color: 'var(--accent-llm)' }} />}
                      <div>
                        <div style={{ fontSize: '14px', fontWeight: '500' }}>{workflow.name}</div>
                        {workflow.description && (
                          <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '2px' }}>
                            {workflow.description}
                          </div>
                        )}
                      </div>
                    </div>
                    
                    {workflow.type === 'example' && (
                      <span className="badge" style={{ fontSize: '10px', marginLeft: '8px', background: 'rgba(139, 92, 250, 0.1)', color: 'var(--accent-llm)', padding: '2px 6px', borderRadius: '4px' }}>
                        Example
                      </span>
                    )}
                    
                    {workflow.type === 'user' && (
                      <button
                        className="btn btn-ghost"
                        onClick={(e) => {
                          e.stopPropagation();
                          deleteWorkflow(workflow.id);
                        }}
                        style={{ padding: '4px' }}
                      >
                        <Trash2 size={14} />
                      </button>
                    )}
                  </div>
                </div>
              ))
            )
          )}
        </div>
      </div>
    </div>
  );
}
