import { useEffect, useRef, useState, useMemo } from 'react';
import { useWorkflowStore } from '../../hooks/useWorkflowStore';
import type { ExecutionEvent } from '../../hooks/useWorkflowStore';
import { DynamicOverlay } from './DynamicOverlay';

export default function ExecutionAuditHub() {
  // God-Mode synchronized audit stream

  const { isAuditHubOpen, toggleAuditHub } = useWorkflowStore();
  const executionEvents = useWorkflowStore((state) => state.executionEvents);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [filter, setFilter] = useState<string | null>(null);

  // Auto-scroll to bottom
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [executionEvents]);

  if (!isAuditHubOpen) return null;
  
  // Memoize filtering and stats to prevent redundant calculations
  const filteredEvents = useMemo(() => 
    filter ? executionEvents.filter(e => e.type === filter) : executionEvents,
    [executionEvents, filter]
  );

  const totalTokens = useMemo(() => 
    executionEvents
      .filter(e => e.type === 'resource_usage')
      .reduce((acc, e) => acc + (e.data?.usage?.total_tokens || 0), 0),
    [executionEvents]
  );
  
  const toolCount = useMemo(() => 
    executionEvents.filter(e => e.type === 'tool_used').length,
    [executionEvents]
  );

  return (
    <DynamicOverlay 
      title="EXECUTION_AUDIT"
      defaultPosition={{ x: (typeof window !== 'undefined' ? window.innerWidth : 1200) / 2 - 450, y: (typeof window !== 'undefined' ? window.innerHeight : 800) - 400 }}
      defaultSize={{ width: 900, height: 350 }}
      onClose={toggleAuditHub}
      dockable={true}
      defaultDocked={false}
      className="!bg-transparent !shadow-none !border-none"
    >
      <div className="execution-audit-hub flex flex-col h-full bg-[#0a0a12]/95 backdrop-blur-xl border-t border-[#00FFFF] font-mono shadow-[0_-10px_40px_rgba(0,0,0,0.5)]">
        {/* Header / Toolbar */}
        <div className="px-4 py-2 bg-white/5 border-b border-white/5 flex items-center justify-between text-[11px]">
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          <span style={{ color: 'var(--primary)', fontWeight: 600 }}>TERMINAL :: EXECUTION_AUDIT</span>
          
          <div style={{ display: 'flex', gap: '8px', opacity: 0.8 }}>
             <span title="Total Tokens Used">💎 {totalTokens.toLocaleString()} tokens</span>
             <span title="Tools Invocations">🛠 {toolCount} tools</span>
          </div>

          <div style={{ display: 'flex', gap: '4px', marginLeft: '12px' }}>
            {['node_progress', 'tool_used', 'resource_usage'].map(f => (
              <button 
                key={f}
                onClick={() => setFilter(filter === f ? null : f)}
                style={{
                  padding: '2px 8px',
                  borderRadius: '4px',
                  background: filter === f ? 'var(--primary)' : 'rgba(255,255,255,0.05)',
                  border: 'none',
                  color: '#fff',
                  fontSize: '9px',
                  cursor: 'pointer'
                }}
              >
                {f.replace('_', ' ').toUpperCase()}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Log Stream */}
      <div 
        ref={scrollRef}
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '12px',
          fontSize: '11px',
          lineHeight: '1.5',
          display: 'flex',
          flexDirection: 'column',
          gap: '4px',
        }}
      >
        {filteredEvents.length === 0 && (
          <div style={{ color: 'rgba(255,255,255,0.2)', textAlign: 'center', marginTop: '20px' }}>
            Listening for execution events...
          </div>
        )}
        
        {filteredEvents.map((event, i) => (
          <div key={i} style={{ display: 'flex', gap: '12px', animation: 'fadeIn 0.2s ease-out' }}>
            <span style={{ color: 'rgba(255,255,255,0.3)', minWidth: '70px' }}>
              [{new Date(event.timestamp).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })}]
            </span>
            
            <EventItem event={event} />
          </div>
        ))}
        </div>

        <style>{`
          @keyframes slideUp {
            from { transform: translateY(100%); }
            to { transform: translateY(0); }
          }
          @keyframes fadeIn {
            from { opacity: 0; }
            to { opacity: 1; }
          }
        `}</style>
      </div>
    </DynamicOverlay>
  );
}

function SafeJSON({ data, label }: { data: any, label?: string }) {
  const [isExpanded, setIsExpanded] = useState(false);
  
  const jsonString = useMemo(() => {
    try {
      // Basic circular reference check/handling for common types
      return JSON.stringify(data, (key, value) => {
        if (typeof value === 'bigint') return value.toString();
        if (value instanceof Error) return { message: value.message, stack: value.stack };
        return value;
      }, 2);
    } catch (e) {
      return `[Serialization Error: ${e instanceof Error ? e.message : 'Unknown'}]`;
    }
  }, [data]);

  const preview = jsonString.length > 100 ? jsonString.substring(0, 100) + '...' : jsonString;

  return (
    <span style={{ cursor: 'pointer', fontFamily: 'monospace' }} onClick={(e) => { e.stopPropagation(); setIsExpanded(!isExpanded); }}>
      {isExpanded ? (
        <pre style={{ 
          margin: '4px 0', 
          padding: '8px', 
          background: 'rgba(0,0,0,0.3)', 
          borderRadius: '4px',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-all',
          maxHeight: '200px',
          overflowY: 'auto'
        }}>
          {jsonString}
        </pre>
      ) : (
        <span style={{ opacity: 0.8 }}>{preview}</span>
      )}
    </span>
  );
}

function EventItem({ event }: { event: ExecutionEvent }) {
  switch (event.type) {
    case 'node_progress':
      return (
        <span style={{ color: '#e2e8f0' }}>
          <span style={{ color: '#8b5cf6' }}>PROG</span> [{event.nodeId}] {event.data?.message}
        </span>
      );
    case 'tool_used':
      return (
        <span style={{ color: '#fab005' }}>
          <span style={{ color: '#fab005', fontWeight: 600 }}>TOOL</span> [{event.nodeId}] call <span style={{ color: '#fff' }}>{event.data?.tool_name}</span>(<SafeJSON data={event.data?.args} />)
        </span>
      );
    case 'resource_usage':
      return (
        <span style={{ color: '#63e6be' }}>
          <span style={{ color: '#63e6be' }}>UTIL</span> {event.data?.model} :: {event.data?.usage?.total_tokens} tokens / {event.data?.duration_ms}ms
        </span>
      );
    case 'node_error':
      return (
        <span style={{ color: '#ff6b6b' }}>
          <span style={{ color: '#ff6b6b', fontWeight: 600 }}>ERR!</span> [{event.nodeId}] {event.data?.error}
        </span>
      );
    default:
      return (
        <span style={{ color: 'rgba(255,255,255,0.5)' }}>
          <span style={{ color: 'rgba(255,255,255,0.5)' }}>INFO</span> [{event.nodeId}] {event.type}
        </span>
      );
  }
}
