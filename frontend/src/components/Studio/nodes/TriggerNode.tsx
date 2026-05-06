import { Handle, Position } from '@xyflow/react';
import { Play, X } from 'lucide-react';
import { useWorkflowStore } from '../../../hooks/useWorkflowStore';

interface TriggerNodeData {
  label?: string;
  config?: {
    triggerType?: string;
  };
}

interface TriggerNodeProps {
  id: string;
  data: TriggerNodeData;
  selected?: boolean;
}

export default function TriggerNode({ id, data, selected }: TriggerNodeProps) {
  const status = useWorkflowStore((state) => state.executionStatus[id] || 'idle');
  const deleteNode = useWorkflowStore((state) => state.deleteNode);

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    deleteNode(id);
  };

  const triggerType = data.config?.triggerType || 'manual';
  const triggerLabels: Record<string, string> = {
    manual: 'Manual',
    chat: 'Chat Input',
    schedule: 'Schedule',
    webhook: 'Webhook',
  };

  return (
    <div className={`workflow-node workflow-node--trigger ${selected ? 'selected' : ''} ${status}`}>
      {/* No input for trigger - it's the start */}
      
      {/* Header */}
      <div className="node-header">
        <div className="node-icon node-icon--trigger">
          <Play size={14} />
        </div>
        <span className="node-title">{data.label || 'Trigger'}</span>
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
          <span className="node-field-label">Type</span>
          <div className="node-field-value">{triggerLabels[triggerType]}</div>
        </div>
      </div>

      {/* Output Section */}
      <div className="node-section node-section--output">
        <span className="node-handle-label">Start</span>
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
