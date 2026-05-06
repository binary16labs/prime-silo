import React, { useState, useRef, useEffect } from 'react';
import { Send, Loader, User, Bot, FileText, AlertCircle, Share2, Zap, Copy, Check, History } from 'lucide-react';
import { useWorkspaceStore } from '../../hooks/useWorkspaceStore';
import { API_BASE_URL, GOVERNANCE_HEADERS } from '../../constants';

interface Message {
  role: 'user' | 'assistant';
  content: string;
  sources?: string[];
  isLoading?: boolean;
  status?: string;
  lineageAudit?: any;
}

export const NotebookChat: React.FC = () => {
  const { currentWorkspace, selectedDocuments, activeLLMProvider, activeLLMModels, activeGraphId } = useWorkspaceStore();
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [chatMode, setChatMode] = useState<'semantic' | 'graph_agent' | 'discovery_swarm'>('semantic');
  const [telemetry, setTelemetry] = useState<{[key: string]: string[]}>({});
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  const handleCopyTrace = (audit: any, index: number) => {
    if (!audit) return;
    const traceBlock = `--- BENNY DIAGNOSTIC TRACE ---
${JSON.stringify(audit, null, 2)}
------------------------------`;
    navigator.clipboard.writeText(traceBlock);
    setCopiedId(index);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const handleSend = async () => {
    if (!input.trim() || loading) return;

    const userMessage = input.trim();
    setInput('');
    setMessages(prev => [...prev, { role: 'user', content: userMessage }]);
    setLoading(true);

    // Placeholder for assistant response to show loading state
    setMessages(prev => [...prev, { role: 'assistant', content: '', isLoading: true }]);

    try {
      // 1. Generate local run_id for event subscription (or use one from response if server allows)
      // Since we don't have the run_id until the POST returns, we can wait for response 
      // or the server can return the run_id immediately. 
      // Actually, my rag_routes.py generates it AFTER receiving the POST. 
      // I'll make a more reactive change: wait for data, then check if it's still loading for more?
      // No, for swarm, the POST stays open until the swarm is DONE. 
      // SO, we need to get the run_id BEFORE or DURING the request.
      
      // I'll modify the logic: 
      // The POST /rag/chat will now return a small "meta" response first? No.
      // WE will generate the run_id here!
      const clientRunId = `chat-${Math.random().toString(36).substr(2, 9)}`;

      // Start listening for events even before the fetch completes
      const eventSource = new EventSource(`${API_BASE_URL}/api/rag/chat/events/${clientRunId}`);
      
      eventSource.onmessage = (event) => {
        try {
          const eData = JSON.parse(event.data);
          if (eData.type === 'v2_telemetry') {
            setTelemetry(prev => ({
              ...prev,
              [clientRunId]: [...(prev[clientRunId] || []), eData.message]
            }));
          }
        } catch (e) {
          console.error("Failed to parse SSE event", e);
        }
      };

      const response = await fetch(`${API_BASE_URL}/api/rag/chat`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          ...GOVERNANCE_HEADERS
        },
        body: JSON.stringify({
          query: userMessage,
          workspace: currentWorkspace,
          selected_sources: selectedDocuments,
          provider: activeLLMProvider,
          model: activeLLMModels[activeLLMProvider],
          mode: chatMode,
          active_nexus_id: activeGraphId,
          run_id: clientRunId // Pass our generated run_id to the server
        })
      });

      if (!response.ok) {
        eventSource.close();
        throw new Error(`Chat failed: ${response.statusText}`);
      }

      const data = await response.json();
      eventSource.close();
      
      // Update the loading assistant message with actual data
      setMessages(prev => {
        const updated = [...prev];
        const lastIndex = updated.length - 1;
        
        // Handle nexus required status specially
        const isNexusRequired = data.status === 'nexus_required';
        const finalContent = isNexusRequired 
          ? `⚠️ **Nexus Context Required**\n\nThe Neural Graph Agent needs a grounded code graph (Nexus) to reason about this workspace. Please select a nexus from the Forge or Map catalog and try again.`
          : data.answer;

        updated[lastIndex] = {
          role: 'assistant',
          content: finalContent,
          sources: data.sources || [],
          status: data.status,
          lineageAudit: data.lineage_audit,
          isLoading: false
        };
        return updated;
      });
    } catch (error) {
      console.error('Chat error:', error);
      setMessages(prev => {
        const updated = [...prev];
        const lastIndex = updated.length - 1;
        updated[lastIndex] = {
          role: 'assistant',
          content: `Sorry, I encountered an error: ${error instanceof Error ? error.message : String(error)}`,
          isLoading: false
        };
        return updated;
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="notebook-chat-container" style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--bg-canvas)' }}>
      {/* Selection Context Header */}
      {selectedDocuments.length > 0 && (
        <div style={{ 
          padding: '8px 16px', 
          background: 'rgba(165, 110, 255, 0.1)', 
          borderBottom: '1px solid var(--border-color)',
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          fontSize: '11px',
          color: 'var(--branch-purple)'
        }}>
          <FileText size={12} />
          <span>Discussing {selectedDocuments.length} selected documents</span>
        </div>
      )}

      {/* Messages Area */}
      <div className="chat-messages" style={{ flex: 1, overflowY: 'auto', padding: '20px' }}>
        {messages.length === 0 && (
          <div className="empty-state" style={{ height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', opacity: 0.5 }}>
            <Bot size={48} style={{ marginBottom: '16px' }} />
            <h3>RAG Discovery Chat</h3>
            <p>Ask anything about your workspace documents.</p>
            {selectedDocuments.length === 0 && (
              <p style={{ fontSize: '11px', marginTop: '12px' }}>
                <AlertCircle size={10} style={{ verticalAlign: 'middle', marginRight: '4px' }} />
                Searching entire workspace. Select files to narrow focus.
              </p>
            )}
          </div>
        )}
        
        {messages.map((msg, i) => (
          <div key={i} className={`message ${msg.role === 'user' ? 'message-user' : 'message-assistant'}`}>
            <div className="message-content">
              {msg.isLoading ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <Loader size={14} className="animate-spin" />
                    <span>{chatMode === 'discovery_swarm' ? 'Scouting Architecture...' : chatMode === 'graph_agent' ? 'Neural Reasoning...' : 'Synthesizing...'}</span>
                  </div>
                  {/* Dynamic Telemetry Logs */}
                  {msg.isLoading && (
                    <div style={{ 
                      fontSize: '10px', 
                      color: 'rgba(255,255,255,0.4)', 
                      fontFamily: 'monospace',
                      paddingLeft: '22px',
                      marginTop: '4px',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '2px'
                    }}>
                      {(telemetry[messages[i-1]?.lineageAudit?.run_id] || []).slice(-3).map((log, idx) => (
                        <div key={idx} style={{ animation: 'fadeIn 0.3s ease' }}>
                          &gt; {log}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                msg.content
              )}
            </div>
            
            {!msg.isLoading && msg.sources && msg.sources.length > 0 && (
              <div className="message-sources">
                <div style={{ fontWeight: 600, marginBottom: '4px', fontSize: '10px' }}>SOURCES:</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                  {msg.sources.map((src, j) => (
                    <span key={j} style={{ background: 'rgba(255,255,255,0.1)', padding: '2px 6px', borderRadius: '4px' }}>
                      {src}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {!msg.isLoading && msg.role === 'assistant' && msg.lineageAudit && (
               <div style={{ 
                 marginTop: '8px', 
                 padding: '4px 8px', 
                 display: 'flex', 
                 justifyContent: 'flex-end'
               }}>
                 <button
                   onClick={() => handleCopyTrace(msg.lineageAudit, i)}
                   title="Copy Diagnostic Trace"
                   style={{
                     background: 'transparent',
                     border: '1px solid var(--border-color)',
                     color: 'var(--text-muted)',
                     borderRadius: '4px',
                     padding: '4px 8px',
                     fontSize: '10px',
                     display: 'flex',
                     alignItems: 'center',
                     gap: '4px',
                     cursor: 'pointer',
                     transition: 'all 0.2s'
                   }}
                 >
                   {copiedId === i ? <Check size={10} /> : <History size={10} />}
                   {copiedId === i ? 'COPIED' : 'COPY TRACE'}
                 </button>
               </div>
            )}
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>

      {/* Mode Toggle Area */}
      <div style={{ 
        padding: '0 16px', 
        marginTop: 'auto',
        borderTop: '1px solid var(--border-color)', 
        background: 'var(--bg-panel)',
        display: 'flex',
        alignItems: 'center',
        gap: '4px'
      }}>
        <button 
          onClick={() => setChatMode('semantic')}
          style={{
            flex: 1,
            padding: '10px',
            fontSize: '11px',
            fontWeight: 600,
            background: chatMode === 'semantic' ? 'rgba(0, 163, 255, 0.1)' : 'transparent',
            color: chatMode === 'semantic' ? 'var(--info-blue)' : 'var(--text-secondary)',
            border: 'none',
            borderBottom: chatMode === 'semantic' ? '2px solid var(--info-blue)' : '2px solid transparent',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '6px',
            cursor: 'pointer',
            transition: 'all 0.2s ease'
          }}
        >
          <Share2 size={12} />
          SEMANTIC RAG
        </button>
        <button 
          onClick={() => setChatMode('graph_agent')}
          style={{
            flex: 1,
            padding: '10px',
            fontSize: '11px',
            fontWeight: 600,
            background: chatMode === 'graph_agent' ? 'rgba(165, 110, 255, 0.1)' : 'transparent',
            color: chatMode === 'graph_agent' ? 'var(--branch-purple)' : 'var(--text-secondary)',
            border: 'none',
            borderBottom: chatMode === 'graph_agent' ? '2px solid var(--branch-purple)' : '2px solid transparent',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '6px',
            cursor: 'pointer',
            transition: 'all 0.2s ease'
          }}
        >
          <Zap size={12} />
          NEURAL AGENT
        </button>
        <button 
          onClick={() => setChatMode('discovery_swarm')}
          style={{
            flex: 1,
            padding: '10px',
            fontSize: '11px',
            fontWeight: 600,
            background: chatMode === 'discovery_swarm' ? 'rgba(59, 130, 246, 0.1)' : 'transparent',
            color: chatMode === 'discovery_swarm' ? '#60a5fa' : 'var(--text-secondary)',
            border: 'none',
            borderBottom: chatMode === 'discovery_swarm' ? '2px solid #60a5fa' : '2px solid transparent',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '6px',
            cursor: 'pointer',
            transition: 'all 0.2s ease'
          }}
        >
          <Share2 size={12} />
          DISCOVERY SWARM
        </button>
      </div>

      {/* Input Area */}
      <div className="chat-input-area" style={{ padding: '16px', background: 'var(--bg-panel)' }}>
        <div style={{ display: 'flex', gap: '12px' }}>
          <input
            type="text"
            className="chat-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSend()}
            placeholder={selectedDocuments.length > 0 ? "Ask about selected documents..." : "Ask about the workspace..."}
            disabled={loading}
            style={{ 
              flex: 1, 
              background: 'var(--bg-input)', 
              border: '1px solid var(--border-color)', 
              borderRadius: 'var(--radius-md)', 
              padding: '12px 16px',
              color: 'var(--text-primary)',
              outline: 'none'
            }}
          />
          <button
            className="btn btn-gradient"
            onClick={handleSend}
            disabled={loading || !input.trim()}
            style={{ width: '44px', height: '44px', borderRadius: 'var(--radius-md)', padding: 0 }}
          >
            {loading ? <Loader size={18} className="animate-spin" /> : <Send size={18} />}
          </button>
        </div>
      </div>
    </div>
  );
};

export default NotebookChat;
