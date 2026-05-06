import { Brain, Target, Search, Lightbulb, ClipboardList } from 'lucide-react';
import { useWorkflowStore } from '../../hooks/useWorkflowStore';

interface ReasoningTracePopoverProps {
  nodeId: string;
}

export default function ReasoningTracePopover({ nodeId }: ReasoningTracePopoverProps) {
  const trace = useWorkflowStore((s) => s.reasoningTraces[nodeId]);

  if (!trace) return null;

  const sections = [
    { label: 'Intent', icon: <Target size={12} />, value: trace.intent, color: '#8b5cf6' },
    { label: 'Observation', icon: <Search size={12} />, value: trace.observation, color: '#3b82f6' },
    { label: 'Inference', icon: <Lightbulb size={12} />, value: trace.inference, color: '#eab308' },
    { label: 'Plan', icon: <ClipboardList size={12} />, value: trace.plan, color: '#22c55e' },
  ];

  return (
    <div style={{
      position: 'absolute',
      bottom: '100%',
      left: '50%',
      transform: 'translateX(-50%) translateY(-10px)',
      zIndex: 50,
      background: 'rgba(15, 15, 30, 0.95)',
      border: '1px solid rgba(139, 92, 246, 0.3)',
      borderRadius: '12px',
      padding: '16px',
      width: '320px',
      backdropFilter: 'blur(12px)',
      boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
      pointerEvents: 'none',
      animation: 'fadeIn 0.2s ease-out',
    }}>
      <style>{`
        @keyframes fadeIn {
          from { opacity: 0; transform: translateX(-50%) translateY(0); }
          to { opacity: 1; transform: translateX(-50%) translateY(-10px); }
        }
      `}</style>
      
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px', borderBottom: '1px solid rgba(255,255,255,0.1)', paddingBottom: '8px' }}>
        <Brain size={14} style={{ color: '#8b5cf6' }} />
        <strong style={{ color: '#8b5cf6', fontSize: '12px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          Agent Execution Record (AER)
        </strong>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        {sections.map((section) => section.value ? (
          <div key={section.label}>
            <div style={{ 
              display: 'flex', 
              alignItems: 'center', 
              gap: '6px', 
              fontSize: '10px', 
              color: section.color, 
              fontWeight: 700, 
              textTransform: 'uppercase',
              marginBottom: '2px'
            }}>
              {section.icon} {section.label}
            </div>
            <div style={{ 
              fontSize: '11px', 
              color: 'var(--text-secondary)', 
              lineHeight: 1.4,
              paddingLeft: '18px'
            }}>
              {section.value}
            </div>
          </div>
        ) : null)}
      </div>

      {/* Tail / Arrow */}
      <div style={{
        position: 'absolute',
        top: '100%',
        left: '50%',
        marginLeft: '-6px',
        width: 0,
        height: 0,
        borderLeft: '6px solid transparent',
        borderRight: '6px solid transparent',
        borderTop: '6px solid rgba(139, 92, 246, 0.3)',
      }} />
    </div>
  );
}
