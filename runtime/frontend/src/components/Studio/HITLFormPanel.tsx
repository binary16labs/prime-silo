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
        setEditMode(false);
        setEdits('');
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
      bottom: '30px',
      left: '50%',
      transform: 'translateX(-50%)',
      zIndex: 200,
      background: 'rgba(15, 15, 30, 0.98)',
      border: '1px solid rgba(245, 158, 11, 0.5)',
      borderRadius: '16px',
      padding: '24px',
      width: '550px',
      maxHeight: '500px',
      overflowY: 'auto',
      backdropFilter: 'blur(20px)',
      boxShadow: '0 12px 48px rgba(0,0,0,0.6)',
      animation: 'slideUp 0.3s ease-out',
    }}>
      <style>{`
        @keyframes slideUp {
          from { transform: translate(-50%, 40px); opacity: 0; }
          to { transform: translate(-50%, 0); opacity: 1; }
        }
      `}</style>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '20px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <div style={{ 
            background: 'rgba(245, 158, 11, 0.1)', 
            padding: '8px', 
            borderRadius: '8px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center'
          }}>
            <AlertTriangle size={20} style={{ color: '#f59e0b' }} />
          </div>
          <div>
            <h3 style={{ margin: 0, fontSize: '16px', fontWeight: 600, color: '#fff' }}>
              Human Policy Override Required
            </h3>
            <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.5)' }}>
              Execution paused due to governance breach
            </div>
          </div>
        </div>
        <div style={{ 
          background: 'rgba(245, 158, 11, 0.1)', 
          color: '#f59e0b', 
          fontSize: '10px', 
          padding: '2px 8px', 
          borderRadius: '4px',
          fontWeight: 700,
          textTransform: 'uppercase',
          letterSpacing: '0.05em'
        }}>
          Gate: {hitlData.nodeName}
        </div>
      </div>

      {/* Breach description */}
      <div style={{
        padding: '16px',
        background: 'rgba(245, 158, 11, 0.05)',
        border: '1px dashed rgba(245, 158, 11, 0.3)',
        borderRadius: '10px',
        fontSize: '13px',
        color: 'var(--text-secondary)',
        marginBottom: '16px',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '8px', color: '#f59e0b', fontWeight: 600 }}>
          <ShieldX size={14} /> BREACH DETAIL
        </div>
        <p style={{ margin: 0, lineHeight: 1.5 }}>{hitlData.action_description}</p>
      </div>

      {/* Reasoning trace */}
      {hitlData.reasoning && (
        <div style={{
          padding: '16px',
          background: 'rgba(139, 92, 246, 0.05)',
          border: '1px solid rgba(139, 92, 246, 0.2)',
          borderRadius: '10px',
          fontSize: '12px',
          marginBottom: '16px',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '8px' }}>
            <Brain size={14} style={{ color: '#8b5cf6' }} />
            <strong style={{ color: '#8b5cf6', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Agent Reasoning (AER)</strong>
          </div>
          <p style={{ margin: 0, color: 'var(--text-secondary)', whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>
            {hitlData.reasoning}
          </p>
        </div>
      )}

      {/* State Summary */}
      <div style={{
          padding: '10px 16px',
          background: 'rgba(255,255,255,0.02)',
          borderRadius: '8px',
          fontSize: '12px',
          color: 'var(--text-tertiary)',
          marginBottom: '20px',
          borderLeft: '3px solid rgba(255,255,255,0.1)'
      }}>
        <strong>Context:</strong> {hitlData.current_state_summary}
      </div>

      {/* Edit mode textarea */}
      {editMode && (
        <div style={{ marginBottom: '20px' }}>
          <div style={{ fontSize: '11px', color: '#fff', marginBottom: '8px', display: 'flex', alignItems: 'center', gap: '6px' }}>
             <Edit3 size={12} /> MODIFICATION BUFFER
          </div>
          <textarea
            style={{
              width: '100%',
              minHeight: '120px',
              padding: '12px',
              background: 'rgba(0,0,0,0.4)',
              border: '1px solid rgba(255,255,255,0.1)',
              borderRadius: '8px',
              color: '#fff',
              fontSize: '13px',
              fontFamily: 'var(--font-mono)',
              lineHeight: 1.6,
              resize: 'vertical',
              outline: 'none',
              transition: 'border-color 0.2s',
            }}
            autoFocus
            placeholder="Edit the data to resolve the breach..."
            value={edits}
            onChange={(e) => setEdits(e.target.value)}
          />
        </div>
      )}

      {/* Decision buttons */}
      <div style={{ display: 'flex', gap: '12px' }}>
        <button
          className="btn btn-gradient"
          disabled={submitting}
          onClick={() => handleDecision('approve')}
          style={{ flex: 1.2, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', height: '42px', borderRadius: '10px' }}
        >
          <ShieldCheck size={18} /> Approve & Resume
        </button>
        <button
          className="btn btn-outline"
          disabled={submitting}
          onClick={() => handleDecision('reject')}
          style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', height: '42px', borderRadius: '10px', color: '#ef4444', borderColor: 'rgba(239, 68, 68, 0.3)' }}
        >
          <ShieldX size={18} /> Terminate
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
          style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', height: '42px', borderRadius: '10px' }}
        >
          <Edit3 size={18} /> {editMode ? 'Finish Editing' : 'Edit & Resume'}
        </button>
      </div>
    </div>
  );
}
