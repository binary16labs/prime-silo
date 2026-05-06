import { useState } from 'react';
import { CheckCircle, XCircle, Loader, Clock, ArrowRight } from 'lucide-react';

interface WaveTask {
  task_id: string;
  description: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  wave?: number;
  assigned_model?: string;
  depth?: number;
  parent_id?: string;
}

interface WaveTimelineProps {
  waves: string[][];           // Array of waves, each containing task_ids
  tasks: WaveTask[];           // All tasks with their current status
  currentWave: number;         // Currently executing wave index
  reviewFindings?: Array<{     // Post-execution review results
    type: string;
    severity: string;
    message: string;
  }>;
  asciiDag?: string;           // ASCII dependency visualization
}

export default function WaveTimeline({ waves, tasks, currentWave, reviewFindings, asciiDag }: WaveTimelineProps) {
  const [showDag, setShowDag] = useState(false);

  const getTaskById = (id: string) => tasks.find(t => t.task_id === id);
  
  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'completed': return <CheckCircle size={14} style={{ color: 'var(--success)' }} />;
      case 'failed': return <XCircle size={14} style={{ color: 'var(--error)' }} />;
      case 'running': return <Loader size={14} className="animate-spin" style={{ color: 'var(--primary)' }} />;
      default: return <Clock size={14} style={{ color: 'var(--text-tertiary)' }} />;
    }
  };

  const getWaveStatus = (waveIdx: number): 'pending' | 'running' | 'completed' => {
    if (waveIdx > currentWave) return 'pending';
    if (waveIdx < currentWave) return 'completed';
    return 'running';
  };

  if (!waves || waves.length === 0) {
    return (
      <div style={{ padding: '16px', color: 'var(--text-tertiary)', fontSize: '13px', textAlign: 'center' }}>
        No wave data available
      </div>
    );
  }

  return (
    <div className="wave-timeline" style={{ padding: '12px', borderTop: '1px solid var(--border-color)', marginTop: '12px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
        <h3 style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-secondary)', margin: 0 }}>
          ⚡ Wave Execution ({waves.length} waves, {tasks.length} tasks)
        </h3>
        {asciiDag && (
          <button 
            className="btn btn-xs btn-ghost" 
            onClick={() => setShowDag(!showDag)}
            style={{ fontSize: '11px' }}
          >
            {showDag ? 'Hide' : 'Show'} DAG
          </button>
        )}
      </div>

      {/* ASCII DAG Visualization */}
      {showDag && asciiDag && (
        <pre style={{
          background: 'rgba(0,0,0,0.3)',
          padding: '12px',
          borderRadius: '6px',
          fontSize: '11px',
          fontFamily: 'monospace',
          color: 'var(--text-secondary)',
          overflowX: 'auto',
          marginBottom: '12px',
          whiteSpace: 'pre-wrap',
          border: '1px solid var(--border-color)'
        }}>
          {asciiDag}
        </pre>
      )}

      {/* Wave columns */}
      <div style={{ display: 'flex', gap: '8px', overflowX: 'auto', paddingBottom: '8px' }}>
        {waves.map((wave, waveIdx) => (
          <div key={waveIdx} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <div style={{
              minWidth: '160px',
              background: getWaveStatus(waveIdx) === 'running' 
                ? 'rgba(139, 92, 246, 0.05)' 
                : 'transparent',
              border: `1px solid ${getWaveStatus(waveIdx) === 'running' ? 'var(--primary)' : 'var(--border-color)'}`,
              borderRadius: '8px',
              padding: '8px',
              opacity: getWaveStatus(waveIdx) === 'pending' ? 0.6 : 1
            }}>
              <div style={{ 
                fontSize: '10px', 
                fontWeight: 600, 
                color: getWaveStatus(waveIdx) === 'running' ? 'var(--primary)' : 'var(--text-tertiary)',
                marginBottom: '8px',
                textTransform: 'uppercase',
                letterSpacing: '1px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between'
              }}>
                <span>Wave {waveIdx}</span>
                {getWaveStatus(waveIdx) === 'running' && <Loader size={10} className="animate-spin" />}
              </div>
              {wave.map(taskId => {
                const task = getTaskById(taskId);
                const taskStatus = task?.status || 'pending';
                return (
                  <div key={taskId} style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: '6px',
                    padding: '8px',
                    background: 'var(--bg-card)',
                    borderRadius: '6px',
                    marginBottom: '6px',
                    fontSize: '11px',
                    border: '1px solid var(--border-color)',
                    boxShadow: '0 2px 4px rgba(0,0,0,0.1)',
                    marginLeft: (task?.depth || 0) * 12 + 'px',
                    borderLeft: task?.depth ? `2px solid var(--accent-color)` : '1px solid var(--border-color)'
                  }}>
                    <div style={{ marginTop: '2px' }}>
                      {getStatusIcon(taskStatus)}
                    </div>
                    <div style={{ overflow: 'hidden' }}>
                      <div style={{ 
                        color: 'var(--text-primary)', 
                        fontWeight: 500,
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis'
                      }}>
                        {task?.description || taskId}
                      </div>
                      {task?.assigned_model && (
                        <div style={{ color: 'var(--text-tertiary)', fontSize: '9px', marginTop: '2px' }}>
                          {task.assigned_model.split('/').pop()}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
            {waveIdx < waves.length - 1 && (
              <ArrowRight size={14} style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />
            )}
          </div>
        ))}
      </div>

      {/* Review Findings */}
      {reviewFindings && reviewFindings.length > 0 && (
        <div style={{ 
          marginTop: '12px', 
          padding: '10px', 
          background: 'rgba(245, 158, 11, 0.05)', 
          borderRadius: '8px', 
          border: '1px solid rgba(245, 158, 11, 0.2)' 
        }}>
          <div style={{ fontSize: '12px', fontWeight: 600, color: '#f59e0b', marginBottom: '8px', display: 'flex', alignItems: 'center', gap: '6px' }}>
            <XCircle size={14} /> Review Findings ({reviewFindings.length})
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            {reviewFindings.map((finding, idx) => (
              <div key={idx} style={{ fontSize: '11px', color: 'var(--text-secondary)', display: 'flex', gap: '6px' }}>
                <span style={{ 
                  color: finding.severity === 'high' ? 'var(--error)' : '#f59e0b',
                  fontWeight: 600,
                  fontSize: '9px',
                  textTransform: 'uppercase',
                  padding: '1px 4px',
                  background: finding.severity === 'high' ? 'rgba(239, 68, 68, 0.1)' : 'rgba(245, 158, 11, 0.1)',
                  borderRadius: '3px',
                  height: 'fit-content'
                }}>
                  {finding.severity}
                </span> 
                {finding.message}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
