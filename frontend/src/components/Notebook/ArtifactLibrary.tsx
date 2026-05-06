import React, { useEffect } from 'react';
import { useWorkspaceStore } from '../../hooks/useWorkspaceStore';
import { Trash2, FileText, Database, Activity, Clock } from 'lucide-react';

export const ArtifactLibrary: React.FC = () => {
  const { synthesisHistory, fetchSynthesisHistory, deleteRun } = useWorkspaceStore();

  useEffect(() => {
    fetchSynthesisHistory();
  }, [fetchSynthesisHistory]);

  const handleDelete = async (e: React.MouseEvent, runId: string) => {
    e.stopPropagation();
    if (confirm('Are you sure you want to delete this synthesis run? This will remove all associated graph data and artifacts.')) {
      await deleteRun(runId);
    }
  };

  const formatDate = (dateStr: string) => {
    try {
      const d = new Date(dateStr);
      return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch {
      return dateStr;
    }
  };

  return (
    <div className="artifact-library" style={{ padding: '24px', height: '100%', overflowY: 'auto' }}>
      <header style={{ marginBottom: '32px' }}>
        <h2 style={{ fontSize: '24px', fontWeight: 700, marginBottom: '8px', color: 'var(--text-primary)' }}>
          Research Blueprint Gallery
        </h2>
        <p style={{ color: 'var(--text-secondary)', fontSize: '14px' }}>
          Manage your historical synthesis runs, artifacts, and spatial blueprints.
        </p>
      </header>

      {synthesisHistory.length === 0 ? (
        <div style={{ 
          display: 'flex', 
          flexDirection: 'column', 
          alignItems: 'center', 
          justifyContent: 'center', 
          padding: '60px',
          background: 'rgba(255,255,255,0.02)',
          borderRadius: 'var(--radius-lg)',
          border: '1px dashed var(--border-color)'
        }}>
          <Database size={48} style={{ color: 'var(--text-muted)', marginBottom: '16px' }} />
          <h3 style={{ color: 'var(--text-secondary)' }}>No synthesis runs yet</h3>
          <p style={{ color: 'var(--text-muted)', fontSize: '13px' }}>Start an ingestion to capture knowledge blueprints.</p>
        </div>
      ) : (
        <div style={{ 
          display: 'grid', 
          gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', 
          gap: '20px' 
        }}>
          {synthesisHistory.map((run) => (
            <div 
              key={run.run_id}
              className="artifact-card"
              style={{
                background: 'var(--bg-card)',
                borderRadius: 'var(--radius-lg)',
                border: '1px solid var(--border-color)',
                padding: '20px',
                position: 'relative',
                transition: 'all var(--transition-normal)',
                cursor: 'pointer',
                display: 'flex',
                flexDirection: 'column',
                gap: '12px',
                boxShadow: 'var(--shadow-md)'
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.borderColor = 'var(--branch-purple)';
                e.currentTarget.style.transform = 'translateY(-4px)';
                e.currentTarget.style.boxShadow = 'var(--shadow-lg), var(--shadow-glow)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.borderColor = 'var(--border-color)';
                e.currentTarget.style.transform = 'translateY(0)';
                e.currentTarget.style.boxShadow = 'var(--shadow-md)';
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div style={{ 
                  width: '40px', 
                  height: '40px', 
                  borderRadius: '12px', 
                  background: 'rgba(165, 110, 255, 0.1)', 
                  display: 'flex', 
                  alignItems: 'center', 
                  justifyContent: 'center',
                  color: 'var(--branch-purple)'
                }}>
                  <FileText size={20} />
                </div>
                <button 
                  onClick={(e) => handleDelete(e, run.run_id)}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    color: 'var(--text-muted)',
                    cursor: 'pointer',
                    padding: '4px',
                    borderRadius: '8px',
                    transition: 'all 0.2s'
                  }}
                  onMouseEnter={(e) => e.currentTarget.style.color = 'var(--accent-error)'}
                  onMouseLeave={(e) => e.currentTarget.style.color = 'var(--text-muted)'}
                >
                  <Trash2 size={16} />
                </button>
              </div>

              <div>
                <h4 style={{ fontSize: '16px', fontWeight: 600, color: 'var(--text-primary)', marginBottom: '4px' }}>
                  {run.files && run.files.length > 0 ? run.files[0] : 'Untitled Run'}
                </h4>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--text-muted)', fontSize: '11px' }}>
                  <Clock size={12} />
                  <span>{formatDate(run.created_at)}</span>
                </div>
              </div>

              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginTop: '4px' }}>
                <span style={{ 
                  padding: '4px 10px', 
                  borderRadius: 'var(--radius-pill)', 
                  background: 'rgba(255,255,255,0.05)', 
                  fontSize: '10px',
                  color: 'var(--text-secondary)',
                  border: '1px solid var(--border-color)'
                }}>
                  {run.model || 'Unknown Model'}
                </span>
                <span style={{ 
                  padding: '4px 10px', 
                  borderRadius: 'var(--radius-pill)', 
                  background: 'rgba(165, 110, 255, 0.05)', 
                  fontSize: '10px',
                  color: 'var(--branch-purple)',
                  border: '1px solid rgba(165, 110, 255, 0.2)'
                }}>
                  v{run.version || '1.0.0'}
                </span>
              </div>

              <div style={{ 
                marginTop: 'auto', 
                paddingTop: '16px', 
                borderTop: '1px solid var(--border-color)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between'
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', color: 'var(--text-secondary)', fontSize: '12px' }}>
                  <Activity size={14} style={{ color: 'var(--branch-teal)' }} />
                  <span>Interactive Blueprint</span>
                </div>
                <div style={{ fontSize: '10px', color: 'var(--text-muted)', fontFamily: 'monospace' }}>
                  {run.run_id.slice(0, 8)}...
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default ArtifactLibrary;
