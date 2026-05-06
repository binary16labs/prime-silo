import { useState, useEffect } from 'react';
import { useWorkspaceStore } from '../../hooks/useWorkspaceStore';
import { Plus, ChevronDown, Check, Folder } from 'lucide-react';

export default function WorkspaceSelector() {
  const { currentWorkspace, workspaces, setCurrentWorkspace, fetchWorkspaces, createWorkspace } = useWorkspaceStore();
  const [isOpen, setIsOpen] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [newWorkspaceName, setNewWorkspaceName] = useState('');

  useEffect(() => {
    fetchWorkspaces();
  }, []);

  const handleCreate = async () => {
    if (!newWorkspaceName.trim()) return;
    
    // Simple validation: alphanumeric + dashes/underscores
    const sanitized = newWorkspaceName.trim().replace(/[^a-zA-Z0-9-_]/g, '-');
    
    const success = await createWorkspace(sanitized);
    if (success) {
      setIsCreating(false);
      setNewWorkspaceName('');
      setIsOpen(false);
    }
  };

  return (
    <div className="workspace-selector-container" style={{ padding: '12px 16px', borderBottom: '1px solid var(--border-color)' }}>
      <div style={{ fontSize: '11px', fontWeight: '600', color: 'var(--text-muted)', marginBottom: '8px', letterSpacing: '0.5px' }}>
        WORKSPACE
      </div>
      
      <div style={{ position: 'relative' }}>
        <button 
          className="btn btn-outline" 
          onClick={() => setIsOpen(!isOpen)}
          style={{ width: '100%', justifyContent: 'space-between', padding: '8px 12px' }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Folder size={14} className="text-secondary" />
            <span style={{ maxWidth: '140px', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {typeof currentWorkspace === 'string' ? currentWorkspace : (currentWorkspace as any)?.id || 'Select...'}
            </span>
          </div>
          <ChevronDown size={14} />
        </button>

        {isOpen && (
          <div className="workspace-dropdown glass-panel">
            {/* List */}
            <div className="workspace-list">
              {workspaces.map((ws) => (
                <button
                  key={ws}
                  className={`workspace-item ${ws === currentWorkspace ? 'active' : ''}`}
                  onClick={() => {
                    setCurrentWorkspace(ws);
                    setIsOpen(false);
                  }}
                >
                  <Folder size={14} />
                  <span style={{ flex: 1 }}>{typeof ws === 'string' ? ws : (ws as any)?.id || 'Unnamed'}</span>
                  {ws === currentWorkspace && <Check size={12} />}
                </button>
              ))}
            </div>

            {/* Create New */}
            <div className="workspace-create">
              {isCreating ? (
                <div style={{ display: 'flex', gap: '4px' }}>
                  <input
                    type="text"
                    value={newWorkspaceName}
                    onChange={(e) => setNewWorkspaceName(e.target.value)}
                    placeholder="Name..."
                    className="form-input"
                    style={{ fontSize: '12px', padding: '6px' }}
                    autoFocus
                    onKeyPress={(e) => e.key === 'Enter' && handleCreate()}
                  />
                  <button className="btn btn-gradient btn-icon" onClick={handleCreate} style={{ width: '28px', height: '28px', padding: 0 }}>
                    <Plus size={14} />
                  </button>
                </div>
              ) : (
                <button 
                  className="btn btn-ghost" 
                  onClick={() => setIsCreating(true)}
                  style={{ width: '100%', justifyContent: 'flex-start', fontSize: '12px' }}
                >
                  <Plus size={14} />
                  New Workspace
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
