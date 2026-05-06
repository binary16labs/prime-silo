import { memo } from 'react';
import { Handle, Position } from '@xyflow/react';
import type { NodeProps } from '@xyflow/react';
import { Globe } from 'lucide-react';

function A2ANode({ data, selected }: NodeProps) {
  const status = data.status as string;
  const config = (data.config || {}) as { agentUrl?: string; agentName?: string };

  return (
    <div className={`workflow-node a2a-node ${selected ? 'selected' : ''} ${status || ''}`}
      style={{
        background: 'linear-gradient(135deg, rgba(14, 165, 233, 0.15), rgba(59, 130, 246, 0.1))',
        border: `2px solid ${selected ? '#0ea5e3' : status === 'error' ? '#ef4444' : status === 'success' ? '#22c55e' : 'rgba(14, 165, 233, 0.4)'}`,
        borderRadius: '12px',
        padding: '12px 16px',
        minWidth: '180px',
        cursor: 'pointer',
      }}>
      <Handle type="target" position={Position.Top} style={{ background: '#0ea5e3' }} />
      
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
        <Globe size={16} style={{ color: '#0ea5e3' }} />
        <span style={{ fontSize: '13px', fontWeight: 600, color: '#fff' }}>
          {(data.label as string) || 'A2A Agent'}
        </span>
      </div>
      
      {config.agentName && (
        <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.6)' }}>
          → {config.agentName}
        </div>
      )}
      {config.agentUrl && (
        <div style={{ fontSize: '10px', color: 'rgba(255,255,255,0.4)', fontFamily: 'monospace' }}>
          {config.agentUrl}
        </div>
      )}
      
      {status && (
        <div style={{
          fontSize: '10px',
          marginTop: '6px',
          padding: '2px 6px',
          borderRadius: '4px',
          background: status === 'success' ? 'rgba(34,197,94,0.2)' : status === 'error' ? 'rgba(239,68,68,0.2)' : 'rgba(14,165,233,0.2)',
          color: status === 'success' ? '#22c55e' : status === 'error' ? '#ef4444' : '#0ea5e3',
          display: 'inline-block',
        }}>
          {status}
        </div>
      )}
      
      <Handle type="source" position={Position.Bottom} style={{ background: '#0ea5e3' }} />
    </div>
  );
}

export default memo(A2ANode);
