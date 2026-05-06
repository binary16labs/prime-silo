import { useLLMStatus } from '../../hooks/useLLMStatus';
import { useWorkspaceStore } from '../../hooks/useWorkspaceStore';
import { Play, Square, RefreshCw, Check, Zap } from 'lucide-react';

export default function LLMManager() {
  const { providers, loading, error, refresh, startProvider, stopProvider } = useLLMStatus(10000);
  const { activeLLMProvider, setActiveLLMProvider, activeLLMModels, setActiveLLMModel } = useWorkspaceStore();

  if (loading && Object.keys(providers).length === 0) {
    return (
      <div className="llm-manager" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
        <div style={{ textAlign: 'center' }}>
          <RefreshCw className="animate-spin" size={32} style={{ marginBottom: '12px', color: 'var(--accent-llm)' }} />
          <p>Loading LLM providers...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="llm-manager" style={{ padding: '32px', overflowY: 'auto', height: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '24px' }}>
        <h2 style={{ fontSize: '24px', fontWeight: '600' }}>🤖 Local LLM Management</h2>
        <button className="btn btn-outline" onClick={refresh}>
          <RefreshCw size={16} />
          Refresh
        </button>
      </div>

      {error && (
        <div style={{ 
          padding: '16px', 
          background: 'rgba(248, 113, 113, 0.1)', 
          border: '1px solid var(--accent-error)',
          borderRadius: 'var(--radius-md)',
          marginBottom: '20px',
          color: 'var(--accent-error)'
        }}>
          ⚠️ {error} - Make sure the Benny API server is running on port 8005
        </div>
      )}

      <div className="provider-grid">
        {Object.entries(providers).map(([key, provider]) => (
          <div key={key} className="provider-card">
            <div className="provider-header">
              <div className={`status-indicator ${provider.running ? 'running' : ''}`} />
              <span className="provider-name">{provider.name}</span>
              <span className="port-badge">:{provider.port}</span>
              {activeLLMProvider === key && (
                <span style={{ 
                  marginLeft: 'auto', 
                  fontSize: '10px', 
                  background: 'rgba(57, 255, 20, 0.15)', 
                  color: 'var(--accent-success)', 
                  padding: '2px 6px', 
                  borderRadius: '10px',
                  border: '1px solid var(--accent-success)'
                }}>
                  ACTIVE
                </span>
              )}
            </div>
            
            <p className="provider-description">{provider.description}</p>
            
            {(provider as any).error && !provider.running && (
              <p style={{ fontSize: '10px', color: 'var(--accent-error)', marginTop: '4px' }}>
                ⚠️ {(provider as any).error}
              </p>
            )}
            
            <div className="provider-controls">

              <button 
                className={`btn btn-sm ${activeLLMProvider === key ? 'btn-primary' : 'btn-outline'}`}
                onClick={() => setActiveLLMProvider(key)}
                style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}
              >
                {activeLLMProvider === key ? <Check size={14} /> : <Zap size={14} />}
                {activeLLMProvider === key ? 'Active' : 'Activate'}
              </button>
              
              <div style={{ width: '1px', background: 'var(--border-color)', margin: '0 8px' }} />

              <button 
                className="btn btn-outline" 
                onClick={() => startProvider(key)}
                disabled={provider.running || !provider.can_start}
                title="Start Service"
              >
                <Play size={14} />
              </button>
              <button 
                className="btn btn-outline" 
                onClick={() => stopProvider(key)}
                disabled={!provider.running || !provider.can_stop}
                title="Stop Service"
              >
                <Square size={14} />
              </button>
            </div>

            {provider.running && provider.models?.data && (
              <div style={{ marginTop: '16px', paddingTop: '16px', borderTop: '1px solid var(--border-color)' }}>
                <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '8px', textTransform: 'uppercase', display: 'flex', justifyContent: 'space-between' }}>
                  <span>Available Models</span>
                  {activeLLMProvider === key && activeLLMModels[key] && (
                    <span style={{ color: 'var(--accent-primary)' }}>Selected: {activeLLMModels[key].split('/').pop()}</span>
                  )}
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                  {provider.models.data.map((model: any) => {
                    const isSelected = activeLLMModels[key] === model.id;
                    const isProviderActive = activeLLMProvider === key;
                    
                    return (
                      <button 
                        key={model.id}
                        onClick={() => {
                          setActiveLLMModel(key, model.id);
                          if (!isProviderActive) setActiveLLMProvider(key);
                        }}
                        style={{
                          fontSize: '11px',
                          padding: '4px 8px',
                          background: isSelected ? 'var(--accent-primary)' : 'var(--bg-input)',
                          color: isSelected ? 'white' : 'inherit',
                          border: `1px solid ${isSelected ? 'var(--accent-primary)' : 'transparent'}`,
                          borderRadius: 'var(--radius-sm)',
                          fontFamily: 'Fira Code, monospace',
                          cursor: 'pointer',
                          transition: 'all 0.2s ease',
                          opacity: isProviderActive ? 1 : 0.7
                        }}
                        title={model.id}
                      >
                        {model.id}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Quick Start Guide */}
      <div style={{ 
        marginTop: '32px', 
        padding: '20px',
        background: 'var(--glass-bg)',
        borderRadius: 'var(--radius-lg)',
        border: '1px solid var(--border-color)'
      }}>
        <h3 style={{ marginBottom: '12px', fontSize: '16px' }}>🚀 Quick Start</h3>
        <ul style={{ color: 'var(--text-secondary)', lineHeight: '1.8', paddingLeft: '20px' }}>
          <li><strong>Ollama</strong>: Click Start or run <code>ollama serve</code></li>
          <li><strong>LM Studio</strong>: Start LM Studio, load a model, and ensure Local Server is running on port 1234</li>
          <li><strong>Lemonade</strong>: Requires AMD NPU - run <code>lemonade-server serve</code></li>
          <li><strong>FastFlowLM</strong>: Requires Intel NPU - start manually on port 52625</li>
        </ul>
      </div>
    </div>
  );
}
