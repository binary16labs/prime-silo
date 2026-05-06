import { useMemo } from 'react';
import { Handle, Position } from '@xyflow/react';
import { Brain, X, Wrench, Terminal } from 'lucide-react';
import { useWorkflowStore } from '../../../hooks/useWorkflowStore';
import { useShallow } from 'zustand/react/shallow';
import ReasoningTracePopover from '../ReasoningTracePopover';

interface LLMNodeData {
  label?: string;
  config?: {
    model?: string;
    systemPrompt?: string;
  };
  statusMessage?: string;
}

interface LLMNodeProps {
  id: string;
  data: LLMNodeData;
  selected?: boolean;
}

export default function LLMNode({ id, data, selected }: LLMNodeProps) {
  const { status, output, reasoning, hasTools } = useWorkflowStore(
    useShallow((state) => ({
      status: state.executionStatus[id] || 'idle',
      output: state.nodeOutputs[id],
      reasoning: state.reasoningTraces[id],
      hasTools: !!state.nodeHasTools[id]
    }))
  );
  
  const deleteNode = useWorkflowStore((state) => state.deleteNode);

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    deleteNode(id);
  };

  return (
    <div className={`workflow-node workflow-node--llm ${selected ? 'selected' : ''} ${status}`}>
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
        <div className="node-icon node-icon--llm" title="View Reasoning Trace (AER)">
          <Brain size={14} />
          {id && <ReasoningTracePopover nodeId={id} />}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
          <span className="node-title">{data.label || 'LLM'}</span>
          {data.statusMessage && (
            <span style={{ 
              fontSize: '9px', 
              color: 'var(--accent-llm)', 
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

      {/* Body / Process */}
      <div className="node-body">
        <div className="node-field">
          <span className="node-field-label">Model</span>
          <div className="node-field-value">{data.config?.model || 'gpt-4-turbo'}</div>
        </div>
        {data.config?.systemPrompt && (
          <div className="node-field">
            <span className="node-field-label">Prompt</span>
            <div className="node-field-value node-field-value--truncate">
              {data.config.systemPrompt.slice(0, 40)}...
            </div>
          </div>
        )}
        {output && (
          <div className="node-output-preview">
            <span className="node-field-label">Output</span>
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

      {/* Persistent Thinking / Reasoning Overlay */}
      {reasoning && (
        <div className={`node-thinking-overlay ${status === 'running' ? 'active' : 'persisted'}`}>
          <div className="thinking-header">
             {hasTools ? <Wrench size={10} className="tool-icon" /> : <Terminal size={10} />}
             <span>{reasoning.intent}</span>
          </div>
          {reasoning.inference && (
            <div className="thinking-body">
              {reasoning.inference}
            </div>
          )}
        </div>
      )}

      <style>{`
        .node-thinking-overlay {
          position: absolute;
          top: 100%;
          left: 0;
          right: 0;
          margin-top: 8px;
          background: rgba(20, 20, 35, 0.85);
          backdrop-filter: blur(12px);
          border: 1px solid rgba(139, 92, 246, 0.3);
          border-radius: 8px;
          padding: 8px;
          font-family: inherit;
          font-size: 10px;
          color: #e2e8f0;
          z-index: 10;
          pointer-events: none;
          box-shadow: 0 4px 12px rgba(0,0,0,0.3);
          transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
        }
        .node-thinking-overlay.active {
          border-color: #8b5cf6;
          box-shadow: 0 0 15px rgba(139, 92, 246, 0.3);
          animation: pulse-border 2s infinite;
        }
        .node-thinking-overlay.persisted {
          opacity: 0.9;
          transform: translateY(0);
          border-color: rgba(255,255,255,0.1);
        }
        .thinking-header {
          display: flex;
          align-items: center;
          gap: 6px;
          color: #8b5cf6;
          font-weight: 600;
          margin-bottom: 4px;
          text-transform: uppercase;
          letter-spacing: 0.05em;
        }
        .thinking-body {
          color: rgba(255,255,255,0.7);
          font-style: italic;
          display: -webkit-box;
          -webkit-line-clamp: 3;
          -webkit-box-orient: vertical;
          overflow: hidden;
        }
        .tool-icon {
          animation: spin-slow 3s linear infinite;
        }
        @keyframes pulse-border {
          0% { border-color: rgba(139, 92, 246, 0.3); }
          50% { border-color: rgba(139, 92, 246, 1); }
          100% { border-color: rgba(139, 92, 246, 0.3); }
        }
        @keyframes spin-slow {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}
