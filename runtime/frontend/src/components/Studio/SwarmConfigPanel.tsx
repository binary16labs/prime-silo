import { Settings2 } from 'lucide-react';
import { useLLMStatus } from '../../hooks/useLLMStatus';
import { useWorkspaceStore } from '../../hooks/useWorkspaceStore';

interface SwarmConfig {
  model: string;
  max_concurrency: number;
  workspace: string;
  discovery_mode?: boolean;
}

interface SwarmConfigPanelProps {
  config: SwarmConfig;
  onChange: (config: SwarmConfig) => void;
}

export default function SwarmConfigPanel({ config, onChange }: SwarmConfigPanelProps) {
  const { providers } = useLLMStatus(10000);
  const { activeLLMProvider, activeLLMModels } = useWorkspaceStore();

  const handleChange = (key: keyof SwarmConfig, value: string | number | boolean) => {
    onChange({ ...config, [key]: value });
  };

  // Build dynamic model options from running providers
  const runningProviders = Object.entries(providers).filter(([, p]) => p.running && p.models?.data);

  return (
    <div className="swarm-config-panel">
      <div className="swarm-config-header">
        <Settings2 size={16} />
        <span>Swarm Configuration</span>
      </div>
      
      <div className="swarm-config-content">
        {/* Model Selector — Dynamic from LLM Management */}
        <div className="form-group">
          <label className="form-label" htmlFor="swarm-model">
            LLM Model
            {activeLLMProvider && providers[activeLLMProvider]?.running && (
              <span style={{ 
                marginLeft: '8px', 
                fontSize: '10px', 
                color: 'var(--accent-success)',
                fontWeight: 400 
              }}>
                ● {providers[activeLLMProvider]?.name} active
              </span>
            )}
          </label>
          <select
            id="swarm-model"
            className="form-select"
            value={config.model}
            onChange={(e) => handleChange('model', e.target.value)}
          >
            {/* Dynamic models from running providers */}
            {runningProviders.map(([key, provider]) => (
              <optgroup key={key} label={`${provider.name} (port ${provider.port}) — Running`}>
                {provider.models.data.map((model: any) => {
                  const isActive = activeLLMProvider === key && activeLLMModels[key] === model.id;
                  return (
                    <option key={model.id} value={model.id}>
                      {model.id}{isActive ? ' ★' : ''}
                    </option>
                  );
                })}
              </optgroup>
            ))}

            {/* Static fallback for cloud models */}
            <optgroup label="Cloud Models">
              <option value="gpt-4-turbo">GPT-4 Turbo</option>
              <option value="claude-3-sonnet">Claude 3 Sonnet</option>
            </optgroup>
          </select>
          {runningProviders.length === 0 && (
            <div className="form-hint" style={{ color: 'var(--accent-warning, #f59e0b)' }}>
              No local LLM providers running. Start one from the LLMs tab.
            </div>
          )}
        </div>

        {/* Concurrency Slider */}
        <div className="form-group">
          <label className="form-label" htmlFor="swarm-concurrency">
            Max Concurrency: <strong>{config.max_concurrency}</strong>
          </label>
          <input
            id="swarm-concurrency"
            type="range"
            className="form-range"
            min={1}
            max={10}
            step={1}
            value={config.max_concurrency}
            onChange={(e) => handleChange('max_concurrency', parseInt(e.target.value))}
          />
          <div className="form-hint">
            {config.max_concurrency === 1 
              ? 'Sequential execution (safe for local LLM)'
              : config.max_concurrency <= 3
              ? 'Low concurrency (recommended for most setups)'
              : 'High concurrency (requires powerful LLM)'}
          </div>
        </div>

        {/* Workspace */}
        <div className="form-group">
          <label className="form-label" htmlFor="swarm-workspace">Workspace</label>
          <input
            id="swarm-workspace"
            type="text"
            className="form-input"
            value={config.workspace}
            onChange={(e) => handleChange('workspace', e.target.value)}
            placeholder="default"
          />
        </div>
        
        {/* Guardrails Readout */}
        <div style={{ 
          marginTop: '16px', 
          padding: '12px', 
          background: 'rgba(59, 130, 246, 0.05)', 
          border: '1px solid rgba(59, 130, 246, 0.15)',
          borderRadius: '6px'
        }}>
          <div style={{ fontSize: '11px', color: '#60a5fa', marginBottom: '8px', fontWeight: 600 }}>🛡️ CONTEXT GUARDRAILS</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
            <div style={{ fontSize: '10px' }}>
              <div style={{ color: 'rgba(255,255,255,0.5)' }}>Max Payload</div>
              <div style={{ color: '#fff' }}>~12,000 Chars</div>
            </div>
            <div style={{ fontSize: '10px' }}>
              <div style={{ color: 'rgba(255,255,255,0.5)' }}>Tool Output</div>
              <div style={{ color: '#fff' }}>2,500 Chars</div>
            </div>
          </div>
          <div style={{ marginTop: '8px', fontSize: '9px', color: 'rgba(255,255,255,0.4)', fontStyle: 'italic' }}>
            Active Profile: {config.model?.includes('gpt') ? 'Cloud-Burst' : 'Local-Hardened'}
          </div>
        </div>

        {/* Discovery Mode Toggle */}
        <div className="form-group" style={{ marginTop: '16px' }}>
          <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer' }}>
            <span style={{ fontSize: '13px', fontWeight: 500, color: '#fff' }}>Progressive Discovery</span>
            <input 
              type="checkbox" 
              checked={config.discovery_mode || false}
              onChange={(e) => handleChange('discovery_mode', e.target.checked)}
              style={{ width: '16px', height: '16px' }}
            />
          </label>
          <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.5)', marginTop: '4px' }}>
            Layered navigation (Arch &rarr; Symbol) for deep codebase analysis.
          </div>
        </div>

      </div>
    </div>
  );
}
