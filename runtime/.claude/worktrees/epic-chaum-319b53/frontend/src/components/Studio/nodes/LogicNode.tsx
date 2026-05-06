import { Handle, Position } from '@xyflow/react';
import { GitBranch, X } from 'lucide-react';
import { useWorkflowStore } from '../../../hooks/useWorkflowStore';

interface LogicNodeData {
  label?: string;
  config?: {
    condition?: string;
  };
}

interface LogicNodeProps {
  id: string;
  data: LogicNodeData;
  selected?: boolean;
}

export default function LogicNode({ id, data, selected }: LogicNodeProps) {
  const status = useWorkflowStore((state) => state.executionStatus[id] || 'idle');
  const deleteNode = useWorkflowStore((state) => state.deleteNode);

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    deleteNode(id);
  };

  return (
    <div className={`workflow-node workflow-node--logic ${selected ? 'selected' : ''} ${status}`}>
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
        <div className="node-icon node-icon--logic">
          <GitBranch size={14} />
        </div>
        <span className="node-title">{data.label || 'Condition'}</span>
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
          <span className="node-field-label">Condition</span>
          <div className="node-field-value">{data.config?.condition || 'if true...'}</div>
        </div>
      </div>

      {/* Multiple Output Branches */}
      <div className="node-section node-section--output node-section--branches">
        <div className="node-branch">
          <span className="node-handle-label node-handle-label--true">True</span>
          <Handle 
            type="source" 
            position={Position.Right} 
            id="true"
            className="node-handle node-handle--output node-handle--true"
            style={{ top: '60%' }}
          />
        </div>
        <div className="node-branch">
          <span className="node-handle-label node-handle-label--false">False</span>
          <Handle 
            type="source" 
            position={Position.Right} 
            id="false"
            className="node-handle node-handle--output node-handle--false"
            style={{ top: '80%' }}
          />
        </div>
      </div>
    </div>
  );
}
