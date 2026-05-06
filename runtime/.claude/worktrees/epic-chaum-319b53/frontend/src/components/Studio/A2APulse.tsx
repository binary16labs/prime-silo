import React, { useEffect, useState } from 'react';
import { Activity, Radio, UserCheck } from 'lucide-react';
import { API_BASE_URL, GOVERNANCE_HEADERS } from '../../constants';

interface A2AMessage {
  id: string;
  from: string;
  to: string;
  content: string;
  timestamp: string;
}

export default function A2APulse() {
  const [messages, setMessages] = useState<A2AMessage[]>([]);

  useEffect(() => {
    const fetchA2A = async () => {
      try {
        const response = await fetch(`${API_BASE_URL}/a2a/pulse`, {
          headers: GOVERNANCE_HEADERS
        });
        if (response.ok) {
          const data = await response.json();
          setMessages(data.messages || []);
        }
      } catch (err) {
        console.error('A2A Pulse fetch failed:', err);
      }
    };

    const interval = setInterval(fetchA2A, 10000);
    fetchA2A();
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="a2a-pulse-container" style={{
      position: 'absolute',
      bottom: '16px',
      right: '316px',
      width: '300px',
      maxHeight: '200px',
      background: 'rgba(15, 23, 42, 0.8)',
      backdropFilter: 'blur(12px)',
      border: '1px solid var(--border-color)',
      borderRadius: '8px',
      overflowY: 'auto',
      zIndex: 100,
      color: 'white',
      padding: '12px'
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px', borderBottom: '1px solid rgba(255,255,255,0.1)', paddingBottom: '8px' }}>
        <Radio size={16} className="text-accent" />
        <span style={{ fontSize: '12px', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.05em' }}>A2A Swarm Pulse</span>
      </div>
      
      {messages.length === 0 ? (
        <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.4)', textAlign: 'center', padding: '10px' }}>
          Searching for agent negotiations...
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {messages.map(msg => (
            <div key={msg.id} style={{ fontSize: '11px', borderLeft: '2px solid var(--accent-color)', paddingLeft: '8px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', opacity: 0.7, marginBottom: '2px' }}>
                <span style={{ fontWeight: 600 }}>{msg.from} → {msg.to}</span>
                <span>{new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
              </div>
              <div style={{ color: 'rgba(255,255,255,0.9)' }}>{msg.content}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
