import { Handle, Position } from '@xyflow/react';
import { Database, X } from 'lucide-react';
import { useWorkflowStore } from '../../../hooks/useWorkflowStore';

interface DataNodeData {
  label?: string;
  config?: {
    operation?: string;
    path?: string;
  };
}

interface DataNodeProps {
  id: string;
  data: DataNodeData;
  selected?: boolean;
}

export default function DataNode({ id, data, selected }: DataNodeProps) {
  const status = useWorkflowStore((state) => state.executionStatus[id] || 'idle');
  const output = useWorkflowStore((state) => state.nodeOutputs[id]);
  const deleteNode = useWorkflowStore((state) => state.deleteNode);

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    deleteNode(id);
  };

  const operationLabels: Record<string, string> = {
    read: 'Read File',
    write: 'Write File',
    search: 'Search KB',
    csv: 'Query CSV',
    adaptive_search: '🧠 Adaptive Search',
  };

  return (
    <div className={`workflow-node workflow-node--data ${selected ? 'selected' : ''} ${status}`}>
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
        <div className="node-icon node-icon--data">
          <Database size={14} />
        </div>
        <span className="node-title">{data.label || 'Data'}</span>
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
          <span className="node-field-label">Operation</span>
          <div className="node-field-value">
            {operationLabels[data.config?.operation || 'read']}
          </div>
        </div>
        {data.config?.path && (
          <div className="node-field">
            <span className="node-field-label">Path</span>
            <div className="node-field-value node-field-value--truncate">
              {data.config.path}
            </div>
          </div>
        )}
        {output && (
          <div className="node-output-preview">
            <span className="node-field-label">Data</span>
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
