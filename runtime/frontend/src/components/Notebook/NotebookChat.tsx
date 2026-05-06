import React, { useState, useRef, useEffect } from 'react';
import { Send, Loader, User, Bot, FileText, AlertCircle, Share2, Zap, Copy, Check, History, Mic, Volume2 } from 'lucide-react';
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
  const [isRecording, setIsRecording] = useState(false);
  const [speakingIdx, setSpeakingIdx] = useState<number | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioChunksRef = useRef<Float32Array[]>([]);
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

  const handleSend = async (overrideInput?: string, audioFile?: File) => {
    const textToSubmit = overrideInput !== undefined ? overrideInput : input.trim();
    if (!textToSubmit && !audioFile) return;
    if (loading) return;

    if (!audioFile) setInput('');
    setMessages(prev => [...prev, { role: 'user', content: textToSubmit || "(Audio message)" }]);
    setLoading(true);

    setMessages(prev => [...prev, { role: 'assistant', content: '', isLoading: true }]);

    try {
      const clientRunId = `chat-${Math.random().toString(36).substr(2, 9)}`;
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

      let data;
      if (audioFile) {
        // Voice Chat Hub Path
        const formData = new FormData();
        formData.append('file', audioFile);
        formData.append('notebook_id', currentWorkspace); // Assuming workspace used as notebook_id for now
        // PBR-001 Phase 3: no hardcoded model. Prefer the workspace's
        // configured voice/chat model; fall back to the active provider's
        // selection. The backend still resolves role="voice" via
        // get_active_model if this is empty.
        const voiceModel = activeLLMModels['voice'] || activeLLMModels[activeLLMProvider] || '';
        if (voiceModel) formData.append('model', voiceModel);
        formData.append('workspace', currentWorkspace);

        const response = await fetch(`${API_BASE_URL}/api/audio/talk`, {
          method: 'POST',
          headers: { 
            ...GOVERNANCE_HEADERS
          },
          body: formData
        });

        if (!response.ok) throw new Error(`Voice chat failed: ${response.statusText}`);
        data = await response.json();
        
        // Handle audio playback
        if (data.audio) {
          const audio = new Audio(`data:${data.media_type};base64,${data.audio}`);
          audio.play().catch(e => console.error("Audio playback failed", e));
        }

        // The voice hub returns {transcript, answer, audio}
        data.answer = data.answer || "No response generated";
      } else {
        // Standard Text Path
        const response = await fetch(`${API_BASE_URL}/api/rag/chat`, {
          method: 'POST',
          headers: { 
            'Content-Type': 'application/json',
            ...GOVERNANCE_HEADERS
          },
          body: JSON.stringify({
            query: textToSubmit,
            workspace: currentWorkspace,
            selected_sources: selectedDocuments,
            provider: activeLLMProvider,
            model: activeLLMModels[activeLLMProvider],
            mode: chatMode,
            active_nexus_id: activeGraphId,
            run_id: clientRunId
          })
        });

        if (!response.ok) {
          eventSource.close();
          throw new Error(`Chat failed: ${response.statusText}`);
        }
        data = await response.json();
      }

      eventSource.close();
      
      setMessages(prev => {
        const updated = [...prev];
        const lastIndex = updated.length - 1;
        
        const isNexusRequired = data.status === 'nexus_required';
        const finalContent = isNexusRequired 
          ? `⚠️ **Nexus Context Required**\n\nThe Neural Graph Agent needs a grounded code graph (Nexus) to reason about this workspace. Please select a nexus from the Forge or Map catalog and try again.`
          : (data.answer || data.message);

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

      // Special case: update the user message if it was an empty audio message initially
      if (audioFile && data.transcript) {
        setMessages(prev => {
          const updated = [...prev];
          const userIndex = updated.length - 2;
          if (updated[userIndex] && updated[userIndex].role === 'user') {
            updated[userIndex].content = `🎤 ${data.transcript}`;
          }
          return updated;
        });
      }

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

  const encodeWAV = (samples: Float32Array, sampleRate: number) => {
    const buffer = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(buffer);

    const writeString = (offset: number, string: string) => {
      for (let i = 0; i < string.length; i++) {
        view.setUint8(offset + i, string.charCodeAt(i));
      }
    };

    writeString(0, 'RIFF');
    view.setUint32(4, 32 + samples.length * 2, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeString(36, 'data');
    view.setUint32(40, samples.length * 2, true);

    let offset = 44;
    for (let i = 0; i < samples.length; i++, offset += 2) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    }

    return new Blob([view], { type: 'audio/wav' });
  };

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      const source = audioContext.createMediaStreamSource(stream);
      const processor = audioContext.createScriptProcessor(4096, 1, 1);

      audioContextRef.current = audioContext;
      processorRef.current = processor;
      streamRef.current = stream;
      audioChunksRef.current = [];

      processor.onaudioprocess = (e) => {
        const inputData = e.inputBuffer.getChannelData(0);
        audioChunksRef.current.push(new Float32Array(inputData));
      };

      source.connect(processor);
      processor.connect(audioContext.destination);
      
      setIsRecording(true);
    } catch (err) {
      console.error("Failed to start recording", err);
      alert("Microphone access denied or not available. Please ensure you are on HTTPS or localhost.");
    }
  };

  const handleSpeak = async (text: string, index: number) => {
    if (speakingIdx === index) return;
    
    setSpeakingIdx(index);
    try {
      const response = await fetch(`${API_BASE_URL}/api/audio/speech`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/x-www-form-urlencoded',
          ...GOVERNANCE_HEADERS 
        },
        body: new URLSearchParams({ text, voice: 'af_sky' })
      });

      if (!response.ok) throw new Error("Speech synthesis failed");
      
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      
      audio.onended = () => {
        setSpeakingIdx(null);
        URL.revokeObjectURL(url);
      };
      
      await audio.play();
    } catch (err) {
      console.error("Failed to speak message", err);
      setSpeakingIdx(null);
    }
  };

  const stopRecording = () => {
    if (processorRef.current && isRecording) {
      processorRef.current.disconnect();
      if (audioContextRef.current) {
        const sampleRate = audioContextRef.current.sampleRate;
        
        // Flatten chunks
        const totalLength = audioChunksRef.current.reduce((acc, chunk) => acc + chunk.length, 0);
        const flattened = new Float32Array(totalLength);
        let offset = 0;
        for (const chunk of audioChunksRef.current) {
          flattened.set(chunk, offset);
          offset += chunk.length;
        }

        const audioBlob = encodeWAV(flattened, sampleRate);
        const audioFile = new File([audioBlob], "voice_input.wav", { type: 'audio/wav' });
        handleSend("", audioFile);
      }

      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop());
      }
      
      setIsRecording(false);
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
            {msg.role === 'assistant' && !msg.isLoading && (
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '4px' }}>
                <button
                  onClick={() => handleSpeak(msg.content, i)}
                  className="btn-icon"
                  title="Read aloud"
                  style={{ 
                    padding: '2px', 
                    color: speakingIdx === i ? 'var(--accent-primary)' : 'var(--text-muted)',
                    opacity: 0.6,
                    cursor: 'pointer',
                    background: 'transparent',
                    border: 'none',
                    display: 'flex',
                    alignItems: 'center'
                  }}
                >
                  <Volume2 size={14} className={speakingIdx === i ? 'animate-pulse' : ''} />
                </button>
              </div>
            )}
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
            className={`btn ${isRecording ? 'btn-danger' : 'btn-gradient'}`}
            onMouseDown={startRecording}
            onMouseUp={stopRecording}
            onMouseLeave={stopRecording}
            disabled={loading}
            style={{ 
              width: '44px', 
              height: '44px', 
              borderRadius: 'var(--radius-md)', 
              padding: 0,
              background: isRecording ? 'var(--error-red)' : undefined,
              boxShadow: isRecording ? '0 0 15px var(--error-red)' : undefined,
              transition: 'all 0.2s ease'
            }}
            title="Push to Talk"
          >
            {isRecording ? <Volume2 size={18} className="animate-pulse" /> : <Mic size={18} />}
          </button>
          <button
            className="btn btn-gradient"
            onClick={() => handleSend()}
            disabled={loading || (!input.trim() && !isRecording)}
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
