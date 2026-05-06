import { Handle, Position } from '@xyflow/react';
import { Wrench, X } from 'lucide-react';
import { useWorkflowStore } from '../../../hooks/useWorkflowStore';
import ReasoningTracePopover from '../ReasoningTracePopover';

interface ToolNodeData {
  label?: string;
  config?: {
    tool?: string;
  };
  statusMessage?: string;
}

interface ToolNodeProps {
  id: string;
  data: ToolNodeData;
  selected?: boolean;
}

export default function ToolNode({ id, data, selected }: ToolNodeProps) {
  const status = useWorkflowStore((state) => state.executionStatus[id] || 'idle');
  const output = useWorkflowStore((state) => state.nodeOutputs[id]);
  const deleteNode = useWorkflowStore((state) => state.deleteNode);

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    deleteNode(id);
  };

  return (
    <div className={`workflow-node workflow-node--tool ${selected ? 'selected' : ''} ${status}`}>
      {/* Input Section */}
      <div className="node-section node-section--input">
        <Handle 
          type="target" 
          position={Position.Left} 
          id="input"
          className="node-handle node-handle--input"
        />
        <span className="node-handle-label">Input</span>
      </div>

      {/* Header */}
      <div className="node-header">
        <div className="node-icon node-icon--tool" title="View Reasoning Trace (AER)">
          <Wrench size={14} />
          {id && <ReasoningTracePopover nodeId={id} />}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
          <span className="node-title">{data.label || 'Tool'}</span>
          {data.statusMessage && (
            <span style={{ 
              fontSize: '9px', 
              color: 'var(--accent-tool)', 
              opacity: 0.8, 
              whiteSpace: 'nowrap', 
              overflow: 'hidden', 
              textOverflow: 'ellipsis',
              animation: 'fadeIn 0.3s ease-in'
            }}>
              {data.statusMessage}
            </span>
          )}
        </div>
        <div className={`node-status node-status--${status}`} />
        <button 
          className="node-delete-btn" 
          onClick={handleDelete}
          title="Delete node"
        >
          <X size={12} />
        </button>
      </div>

      {/* Body */}
      <div className="node-body">
        <div className="node-field">
          <span className="node-field-label">Tool</span>
          <div className="node-field-value">{data.config?.tool || 'select tool...'}</div>
        </div>
        {output && (
          <div className="node-output-preview">
            <span className="node-field-label">Result</span>
            <div className="node-field-value node-field-value--truncate">
              {typeof output === 'string' ? output.slice(0, 60) : JSON.stringify(output).slice(0, 60)}...
            </div>
          </div>
        )}
      </div>

      {/* Output Section */}
      <div className="node-section node-section--output">
        <span className="node-handle-label">Output</span>
        <Handle 
          type="source" 
          position={Position.Right} 
          id="output"
          className="node-handle node-handle--output"
        />
      </div>
    </div>
  );
}
