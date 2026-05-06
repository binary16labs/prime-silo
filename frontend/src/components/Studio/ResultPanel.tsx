import { X } from 'lucide-react';

interface ResultPanelProps {
  isOpen: boolean;
  onClose: () => void;
}

export default function ResultPanel({ isOpen, onClose }: ResultPanelProps) {
  if (!isOpen) return null;

  return (
    <div 
      className="result-panel"
      style={{
        width: '400px',
        height: '100%',
        background: 'var(--surface)',
        borderLeft: '1px solid var(--border-color)',
        display: 'flex',
        flexDirection: 'column'
      }}
    >
      {/* Header */}
      <div style={{
        padding: '16px',
        borderBottom: '1px solid var(--border-color)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between'
      }}>
        <h3 style={{ fontSize: '16px', fontWeight: '600', margin: 0 }}>Results</h3>
        <button className="btn btn-ghost" onClick={onClose} style={{ padding: '4px' }}>
          <X size={18} />
        </button>
      </div>

      {/* Content */}
      <div style={{ flex: 1, padding: '16px', overflowY: 'auto' }}>
        {/* Empty State */}
        <div style={{ 
          textAlign: 'center', 
          padding: '40px 20px',
          color: 'var(--text-muted)'
        }}>
          <div style={{ fontSize: '14px', marginBottom: '8px' }}>No results yet</div>
          <div style={{ fontSize: '12px' }}>
            Run a workflow to see outputs here
          </div>
        </div>

        {/* TODO: Add result rendering, markdown support, citations */}
      </div>
    </div>
  );
}
