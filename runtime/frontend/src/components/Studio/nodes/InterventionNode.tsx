import { Handle, Position } from '@xyflow/react';
import { ShieldAlert, AlertTriangle, CheckCircle, XCircle, Clock } from 'lucide-react';
import ReasoningTracePopover from '../ReasoningTracePopover';

interface InterventionNodeProps {
  id: string;
  data: {
    label: string;
    status?: 'idle' | 'running' | 'success' | 'error';
    executionOutput?: string;
    config?: {
      rule?: string;
      description?: string;
    };
  };
  selected?: boolean;
}

export default function InterventionNode({ id, data, selected }: InterventionNodeProps) {
  const isRunning = data.status === 'running';
  const isSuccess = data.status === 'success';
  const isError = data.status === 'error';

  return (
    <div style={{
      background: 'rgba(15, 15, 25, 0.9)',
      border: `2px solid ${
        selected ? '#f59e0b' : isError ? '#ef4444' : isSuccess ? '#22c55e' : 'rgba(245, 158, 11, 0.4)'
      }`,
      borderRadius: '12px',
      padding: '12px',
      minWidth: '180px',
      boxShadow: isRunning ? '0 0 20px rgba(245, 158, 11, 0.3)' : '0 4px 12px rgba(0,0,0,0.3)',
      color: '#fff',
      fontSize: '13px',
      backdropFilter: 'blur(10px)',
      transition: 'all 0.3s ease',
      position: 'relative',
    }}>
      <Handle type="target" position={Position.Top} style={{ background: '#f59e0b' }} />
      
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
        <div style={{
          background: 'rgba(245, 158, 11, 0.2)',
          padding: '6px',
          borderRadius: '8px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center'
        }}>
          <ShieldAlert size={16} style={{ color: '#f59e0b' }} />
        </div>
        <div style={{ fontWeight: 600 }}>{data.label || 'Intervention'}</div>
        
        <div style={{ marginLeft: 'auto' }}>
          {isRunning && <Clock size={14} className="animate-spin" style={{ color: '#f59e0b' }} />}
          {isSuccess && <CheckCircle size={14} style={{ color: '#22c55e' }} />}
          {isError && <XCircle size={14} style={{ color: '#ef4444' }} />}
        </div>
      </div>

      <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.6)', marginBottom: '8px' }}>
        Policy enforcement gate
      </div>

      {data.config?.rule && (
        <div style={{ 
          fontSize: '10px', 
          background: 'rgba(255,255,255,0.05)', 
          padding: '4px 8px', 
          borderRadius: '4px',
          fontFamily: 'monospace',
          color: '#f59e0b',
          border: '1px solid rgba(245, 158, 11, 0.2)'
        }}>
          Rule: {data.config.rule}
        </div>
      )}

      {data.executionOutput && (
        <div style={{
          marginTop: '8px',
          padding: '8px',
          background: 'rgba(0,0,0,0.3)',
          borderRadius: '6px',
          fontSize: '11px',
          maxHeight: '60px',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          borderLeft: `2px solid ${isError ? '#ef4444' : '#22c55e'}`
        }}>
          {data.executionOutput}
        </div>
      )}

      <Handle type="source" position={Position.Bottom} style={{ background: '#f59e0b' }} />
      
      {/* Reasoning Trace Popover (if hovering child or specified area) */}
      <ReasoningTracePopover nodeId={id} />
    </div>
  );
}
