import React from 'react';
import { useLLMStatus } from '../../hooks/useLLMStatus';
import { useWorkspaceStore } from '../../hooks/useWorkspaceStore';
import { useWorkflowStore } from '../../hooks/useWorkflowStore';
import { 
  Play, 
  Square, 
  RefreshCw, 
  Check, 
  Zap, 
  X, 
  Cpu, 
  MessageSquare, 
  BrainCircuit, 
  Mic, 
  Volume2, 
  Network 
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

const ROLE_ICONS: Record<string, any> = {
  chat: MessageSquare,
  swarm: BrainCircuit,
  stt: Mic,
  tts: Volume2,
  graph_synthesis: Network
};

const ROLE_LABELS: Record<string, string> = {
  chat: 'Primary Chat',
  swarm: 'Swarm Reasoning',
  stt: 'Speech-to-Text',
  tts: 'Text-to-Speech',
  graph_synthesis: 'Graph Synthesis'
};

export default function V2LLMOverlay() {
  const { providers, loading, error, refresh, startProvider, stopProvider } = useLLMStatus(10000);
  const { 
    activeLLMProvider, 
    setActiveLLMProvider, 
    modelRoles, 
    setActiveModelRole,
    syncManifest
  } = useWorkspaceStore();
  
  // Access unified workflow store for UI state
  const { isLLMManagerOpen, setIsLLMManagerOpen } = useWorkflowStore() as any;

  if (!isLLMManagerOpen) return null;

  // Gather all available models across all running providers
  const allModels = Object.entries(providers)
    .filter(([_, p]) => p.running)
    .flatMap(([providerKey, p]) => 
      (p.models?.data || []).map((m: any) => ({
        id: m.id,
        provider: providerKey,
        fullId: `${providerKey}/${m.id}`
      }))
    );

  return (
    <motion.div 
      className="v2-llm-overlay"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        width: '100vw',
        height: '100vh',
        background: 'rgba(0, 0, 0, 0.8)',
        backdropFilter: 'blur(12px)',
        zIndex: 2000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '40px'
      }}
    >
      <motion.div
        className="llm-modal"
        initial={{ scale: 0.9, opacity: 0, y: 20 }}
        animate={{ scale: 1, opacity: 1, y: 0 }}
        style={{
          width: '100%',
          maxWidth: '1000px',
          height: '80vh',
          background: 'var(--bg-panel)',
          border: '1px solid var(--border-color)',
          borderRadius: '24px',
          display: 'flex',
          flexDirection: 'column',
          boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.5)',
          overflow: 'hidden'
        }}
      >
        {/* Header */}
        <div style={{ padding: '24px 32px', borderBottom: '1px solid var(--border-color)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
            <div style={{ padding: '10px', background: 'rgba(57, 255, 20, 0.1)', borderRadius: '12px', color: 'var(--accent-llm)' }}>
              <Cpu size={24} />
            </div>
            <div>
              <h2 style={{ fontSize: '20px', fontWeight: 'bold', margin: 0 }}>Role-Based Orchestrator</h2>
              <p style={{ fontSize: '12px', color: 'var(--text-muted)', margin: 0 }}>Assign task-specific brains for optimized neural performance</p>
            </div>
          </div>
          
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <button className="btn btn-outline" onClick={refresh} title="Refresh Providers">
               <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
            </button>
            <button 
              onClick={() => setIsLLMManagerOpen(false)}
              style={{ 
                background: 'rgba(255,255,255,0.05)', 
                border: 'none', 
                padding: '8px', 
                borderRadius: '50%', 
                cursor: 'pointer',
                color: 'var(--text-muted)'
              }}
            >
              <X size={20} />
            </button>
          </div>
        </div>

        {/* Content Scroll Area */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '32px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '32px' }}>
          
          {/* Left Column: Role Matrix */}
          <div>
            <h3 style={{ fontSize: '14px', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)', marginBottom: '20px', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Zap size={14} className="text-yellow-400" /> Neural Role Matrix
            </h3>
            
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              {Object.entries(ROLE_LABELS).map(([role, label]) => {
                const Icon = ROLE_ICONS[role] || MessageSquare;
                const activeModel = modelRoles[role] || 'Not Assigned';
                
                return (
                  <div key={role} style={{ 
                    padding: '16px', 
                    background: 'rgba(255,255,255,0.03)', 
                    border: '1px solid var(--border-color)', 
                    borderRadius: '16px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '16px'
                  }}>
                    <div style={{ width: '40px', height: '40px', background: 'rgba(255,255,255,0.05)', borderRadius: '10px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--accent-primary)' }}>
                      <Icon size={20} />
                    </div>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: '13px', fontWeight: '600' }}>{label}</div>
                      <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontFamily: 'monospace' }}>
                        {activeModel}
                      </div>
                    </div>
                    <select 
                      value={activeModel} 
                      onChange={(e) => setActiveModelRole(role, e.target.value)}
                      style={{ 
                        background: 'var(--bg-input)', 
                        border: '1px solid var(--border-color)', 
                        borderRadius: '6px', 
                        fontSize: '11px', 
                        padding: '4px 8px',
                        color: 'var(--text-main)',
                        maxWidth: '120px'
                      }}
                    >
                      <option value="">- Default -</option>
                      {allModels.map(m => (
                        <option key={m.fullId} value={m.fullId}>{m.id}</option>
                      ))}
                    </select>
                  </div>
                );
              })}
            </div>

            <div style={{ marginTop: '24px', padding: '16px', borderRadius: '12px', background: 'rgba(57, 255, 20, 0.05)', border: '1px dotted var(--accent-success)', color: 'var(--accent-success)', fontSize: '12px' }}>
               💡 Role assignments are persisted to <code>manifest.yaml</code> and will be respected by all orchestrator tasks.
            </div>
          </div>

          {/* Right Column: Provider Management */}
          <div>
            <h3 style={{ fontSize: '14px', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)', marginBottom: '20px' }}>
              Provider Registry
            </h3>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              {Object.entries(providers).map(([key, provider]) => (
                <div key={key} style={{ 
                  padding: '16px', 
                  borderRadius: '16px', 
                  border: `1px solid ${activeLLMProvider === key ? 'var(--accent-primary)' : 'var(--border-color)'}`,
                  background: activeLLMProvider === key ? 'rgba(var(--accent-primary-rgb), 0.05)' : 'transparent'
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '12px' }}>
                    <div style={{ 
                      width: '8px', 
                      height: '8px', 
                      borderRadius: '50%', 
                      background: provider.running ? 'var(--accent-success)' : 'var(--text-muted)',
                      boxShadow: provider.running ? '0 0 10px var(--accent-success)' : 'none'
                    }} />
                    <span style={{ fontWeight: '600', fontSize: '14px' }}>{provider.name}</span>
                    <span style={{ fontSize: '10px', color: 'var(--text-muted)', padding: '2px 6px', background: 'rgba(255,255,255,0.05)', borderRadius: '4px' }}>
                       :{provider.port}
                    </span>
                    {activeLLMProvider === key && (
                      <span style={{ marginLeft: 'auto', fontSize: '10px', color: 'var(--accent-primary)', fontWeight: 'bold' }}>DEFAULT</span>
                    )}
                  </div>

                  <div style={{ display: 'flex', gap: '8px' }}>
                    <button 
                      className={`btn btn-xs ${activeLLMProvider === key ? 'btn-primary' : 'btn-outline'}`}
                      onClick={() => setActiveLLMProvider(key)}
                      style={{ flex: 1, fontSize: '10px' }}
                    >
                      {activeLLMProvider === key ? <Check size={12} /> : <Zap size={12} />}
                      {activeLLMProvider === key ? 'Active' : 'Set Global'}
                    </button>
                    {!provider.running ? (
                      <button className="btn btn-xs btn-outline" onClick={() => startProvider(key)} disabled={!provider.can_start}>
                        <Play size={12} /> Start
                      </button>
                    ) : (
                      <button className="btn btn-xs btn-outline" onClick={() => stopProvider(key)} disabled={!provider.can_stop}>
                        <Square size={12} /> Stop
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>

        </div>

        {/* Footer */}
        <div style={{ padding: '16px 32px', borderTop: '1px solid var(--border-color)', display: 'flex', justifyContent: 'flex-end', background: 'rgba(255,255,255,0.02)' }}>
          <p style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
            Benny Studio Multi-Role Orchestrator v2.1.0-NPU
          </p>
        </div>
      </motion.div>
    </motion.div>
  );
}
