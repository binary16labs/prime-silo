import { useState, useEffect } from 'react';
import { X, Trash2, ArrowRight, ArrowLeft } from 'lucide-react';
import { useWorkflowStore } from '../../hooks/useWorkflowStore';
import { useLLMStatus } from '../../hooks/useLLMStatus';
import { useWorkspaceStore } from '../../hooks/useWorkspaceStore';
import { API_BASE_URL, GOVERNANCE_HEADERS } from '../../constants';

interface Skill {
  id: string;
  name: string;
  description: string;
  category: string;
}

interface ConfigPanelProps {
  isOpen: boolean;
  nodeId: string | null;
}

export default function ConfigPanel({ isOpen, nodeId }: ConfigPanelProps) {
  const [activeTab, setActiveTab] = useState<'settings' | 'input' | 'output' | 'compute'>('settings');
  const [availableSkills, setAvailableSkills] = useState<Skill[]>([]);
  const nodes = useWorkflowStore((state) => state.nodes);
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);
  const setSelectedNode = useWorkflowStore((state) => state.setSelectedNode);
  const deleteNode = useWorkflowStore((state) => state.deleteNode);
  const getConnectedNodes = useWorkflowStore((state) => state.getConnectedNodes);
  const nodeOutputs = useWorkflowStore((state) => state.nodeOutputs);
  const { providers } = useLLMStatus(10000);
  const { currentWorkspace, activeLLMProvider, activeLLMModels } = useWorkspaceStore();

  useEffect(() => {
    if (isOpen && nodeId) {
      const node = nodes.find(n => n.id === nodeId);
      if (node && node.type === 'llm') {
        const fetchSkills = async () => {
          try {
            const res = await fetch(`${API_BASE_URL}/api/skills?workspace=${currentWorkspace || 'default'}`, {
              headers: { ...GOVERNANCE_HEADERS }
            });
            if (res.ok) {
              const data = await res.json();
              setAvailableSkills(data.skills || []);
            }
          } catch (e) {
            console.error('Failed to fetch skills:', e);
          }
        };
        fetchSkills();
      }
    }
  }, [isOpen, nodeId, currentWorkspace, nodes]);

  // Build dynamic model options from running providers
  const runningProviders = Object.entries(providers).filter(([, p]) => p.running && p.models?.data);

  const node = nodes.find((n) => n.id === nodeId);
  const output = nodeId ? nodeOutputs[nodeId] : null;
  const connections = nodeId ? getConnectedNodes(nodeId) : { inputs: [], outputs: [] };

  if (!node) return null;

  const handleClose = () => {
    setSelectedNode(null);
  };

  const handleDelete = () => {
    if (confirm(`Delete node "${node.data.label || node.type}"?`)) {
      deleteNode(node.id);
    }
  };

  const handleLabelChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    updateNodeData(node.id, { label: e.target.value });
  };

  const handleConfigChange = (key: string, value: any) => {
    updateNodeData(node.id, { 
      config: { 
        ...(node.data.config as object || {}), 
        [key]: value 
      } 
    });
  };

  return (
    <div className={`config-panel ${isOpen ? 'open' : ''}`}>
      <div className="config-header">
        <h2>{String(node.data.label || node.type)}</h2>
        <div style={{ display: 'flex', gap: '8px' }}>
          <button 
            className="btn btn-icon btn-ghost" 
            onClick={handleDelete}
            title="Delete node"
            aria-label="Delete node"
          >
            <Trash2 size={16} />
          </button>
          <button 
            className="btn btn-icon btn-ghost" 
            onClick={handleClose}
            title="Close panel"
            aria-label="Close panel"
          >
            <X size={18} />
          </button>
        </div>
      </div>

      <div className="config-tabs">
        <button 
          className={`config-tab ${activeTab === 'settings' ? 'active' : ''}`}
          onClick={() => setActiveTab('settings')}
        >
          Settings
        </button>
        <button 
          className={`config-tab ${activeTab === 'input' ? 'active' : ''}`}
          onClick={() => setActiveTab('input')}
        >
          Input ({connections.inputs.length})
        </button>
        <button 
          className={`config-tab ${activeTab === 'output' ? 'active' : ''}`}
          onClick={() => setActiveTab('output')}
        >
          Output ({connections.outputs.length})
        </button>
        <button 
          className={`config-tab ${activeTab === 'compute' ? 'active' : ''}`}
          onClick={() => setActiveTab('compute')}
        >
          Compute
        </button>
      </div>

      <div className="config-content">
        {activeTab === 'settings' && (
          <>
            <div className="form-group">
              <label className="form-label" htmlFor="node-name">Node Name</label>
              <input 
                id="node-name"
                type="text" 
                className="form-input" 
                value={String(node.data.label || '')} 
                onChange={handleLabelChange}
                placeholder="Enter node name..."
              />
            </div>

            {node.type === 'llm' && (
              <>
                <div className="form-group">
                  <label className="form-label" htmlFor="llm-model">Model</label>
                  <select 
                    id="llm-model"
                    className="form-select" 
                    value={(node.data.config as {model?: string})?.model || 'gpt-4-turbo'}
                    onChange={(e) => handleConfigChange('model', e.target.value)}
                    title="Select LLM model"
                    aria-label="Select LLM model"
                  >
                    {/* Dynamic models from running providers */}
                    {runningProviders.map(([key, provider]) => (
                      <optgroup key={key} label={`${provider.name} (Running)`}>
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
                    <optgroup label="Cloud Models">
                      <option value="gpt-4-turbo">GPT-4 Turbo (OpenAI)</option>
                      <option value="claude-3-sonnet">Claude 3 Sonnet (Anthropic)</option>
                      <option value="gpt-3.5-turbo">GPT-3.5 Turbo (OpenAI)</option>
                    </optgroup>
                  </select>
                </div>
                <div className="form-group">
                  <label className="form-label" htmlFor="system-prompt">System Prompt</label>
                  <textarea 
                    id="system-prompt"
                    className="form-textarea" 
                    placeholder="You are a helpful assistant..."
                    value={(node.data.config as {systemPrompt?: string})?.systemPrompt || ''}
                    onChange={(e) => handleConfigChange('systemPrompt', e.target.value)}
                  />
                </div>
                
                <div className="form-group">
                  <label className="form-label">Attached Skills</label>
                  <div className="skills-container" style={{ display: 'flex', flexDirection: 'column', gap: '8px', maxHeight: '200px', overflowY: 'auto', padding: '8px', background: 'rgba(0,0,0,0.2)', borderRadius: '4px' }}>
                    {availableSkills.length === 0 ? (
                      <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.5)', textAlign: 'center' }}>No skills available</div>
                    ) : (
                      // Group by category
                      Object.entries(
                        availableSkills.reduce((acc, skill) => {
                          const cat = skill.category || 'custom';
                          if (!acc[cat]) acc[cat] = [];
                          acc[cat].push(skill);
                          return acc;
                        }, {} as Record<string, Skill[]>)
                      ).map(([category, skills]) => (
                        <div key={category} style={{ marginBottom: '8px' }}>
                          <div style={{ fontSize: '11px', textTransform: 'uppercase', color: 'rgba(255,255,255,0.6)', marginBottom: '4px' }}>
                            {category}
                          </div>
                          {skills.map(skill => {
                            const attachedSkills = ((node.data.config as any)?.skills || []) as string[];
                            const isAttached = attachedSkills.includes(skill.id);
                            return (
                              <label key={skill.id} style={{ display: 'flex', alignItems: 'flex-start', gap: '8px', cursor: 'pointer', padding: '4px' }}>
                                <input 
                                  type="checkbox"
                                  checked={isAttached}
                                  onChange={(e) => {
                                    const checked = e.target.checked;
                                    const currentSkills = new Set(attachedSkills);
                                    if (checked) currentSkills.add(skill.id);
                                    else currentSkills.delete(skill.id);
                                    handleConfigChange('skills', Array.from(currentSkills) as any);
                                  }}
                                  style={{ marginTop: '4px' }}
                                />
                                <div>
                                  <div style={{ fontSize: '13px', color: '#fff' }}>{skill.name}</div>
                                  <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.5)' }}>{skill.description}</div>
                                </div>
                              </label>
                            );
                          })}
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </>
            )}

            {node.type === 'trigger' && (
              <div className="form-group">
                <label className="form-label" htmlFor="trigger-type">Trigger Type</label>
                <select 
                  id="trigger-type"
                  className="form-select" 
                  value={(node.data.config as {triggerType?: string})?.triggerType || 'manual'}
                  onChange={(e) => handleConfigChange('triggerType', e.target.value)}
                  title="Select trigger type"
                  aria-label="Select trigger type"
                >
                  <option value="manual">Manual</option>
                  <option value="chat">Chat Input</option>
                  <option value="schedule">Schedule (Cron)</option>
                  <option value="webhook">Webhook</option>
                </select>
              </div>
            )}

            {node.type === 'tool' && (
              <div className="form-group">
                <label className="form-label" htmlFor="tool-select">Tool</label>
                <select 
                  id="tool-select"
                  className="form-select" 
                  value={(node.data.config as {tool?: string})?.tool || ''}
                  onChange={(e) => handleConfigChange('tool', e.target.value)}
                  title="Select tool"
                  aria-label="Select tool"
                >
                  <option value="">Select a tool...</option>
                  <option value="search_knowledge">Search Knowledge Base</option>
                  <option value="read_file">Read File</option>
                  <option value="write_file">Write File</option>
                  <option value="extract_pdf">Extract PDF Text</option>
                  <option value="query_csv">Query CSV</option>
                  <option value="web_search">Web Search</option>
                </select>
              </div>
            )}

            {node.type === 'data' && (
              <>
                <div className="form-group">
                  <label className="form-label" htmlFor="data-operation">Operation</label>
                  <select 
                    id="data-operation"
                    className="form-select" 
                    value={(node.data.config as {operation?: string})?.operation || 'read'}
                    onChange={(e) => handleConfigChange('operation', e.target.value)}
                    title="Select operation"
                    aria-label="Select data operation"
                  >
                    <option value="read">Read File</option>
                    <option value="write">Write File</option>
                    <option value="search">Search Knowledge Base</option>
                    <option value="csv">Query CSV</option>
                    <option value="adaptive_search">Adaptive RAG Search (AI-Powered)</option>
                  </select>
                </div>
                
                {/* Adaptive RAG Configuration — only shown when operation is adaptive_search */}
                {(node.data.config as {operation?: string})?.operation === 'adaptive_search' && (
                  <>
                    <div className="form-group">
                      <label className="form-label" htmlFor="rag-max-retries">
                        Max Retries: <strong>{(node.data.config as any)?.maxRetries || 3}</strong>
                      </label>
                      <input
                        id="rag-max-retries"
                        type="range"
                        className="form-range"
                        min={1}
                        max={5}
                        step={1}
                        value={(node.data.config as any)?.maxRetries || 3}
                        onChange={(e) => handleConfigChange('maxRetries', e.target.value)}
                      />
                    </div>
                    <div className="form-group">
                      <label className="form-label" htmlFor="rag-multi-hop-depth">
                        Multi-Hop Depth: <strong>{(node.data.config as any)?.multiHopDepth || 3}</strong>
                      </label>
                      <input
                        id="rag-multi-hop-depth"
                        type="range"
                        className="form-range"
                        min={1}
                        max={5}
                        step={1}
                        value={(node.data.config as any)?.multiHopDepth || 3}
                        onChange={(e) => handleConfigChange('multiHopDepth', e.target.value)}
                      />
                    </div>
                    <div className="form-group">
                      <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
                        <input
                          type="checkbox"
                          checked={(node.data.config as any)?.enableHallucinationCheck !== false}
                          onChange={(e) => handleConfigChange('enableHallucinationCheck', e.target.checked)}
                        />
                        <span className="form-label" style={{ margin: 0 }}>Enable Hallucination Grading</span>
                      </label>
                    </div>
                  </>
                )}
                <div className="form-group">
                  <label className="form-label" htmlFor="file-path">File Path</label>
                  <input 
                    id="file-path"
                    type="text" 
                    className="form-input" 
                    placeholder="/path/to/file.txt"
                    value={(node.data.config as {path?: string})?.path || ''}
                    onChange={(e) => handleConfigChange('path', e.target.value)}
                  />
                </div>
              </>
            )}

            {node.type === 'logic' && (
              <div className="form-group">
                <label className="form-label" htmlFor="condition">Condition</label>
                <textarea 
                  id="condition"
                  className="form-textarea" 
                  placeholder="output.contains('success')"
                  value={(node.data.config as {condition?: string})?.condition || ''}
                  onChange={(e) => handleConfigChange('condition', e.target.value)}
                />
              </div>
            )}

            {node.type === 'a2a' && (
              <>
                <div className="form-group">
                  <label className="form-label" htmlFor="agent-url">Agent URL</label>
                  <input
                    id="agent-url"
                    type="text"
                    className="form-input"
                    placeholder="http://remote-agent:8005"
                    value={(node.data.config as any)?.agentUrl || ''}
                    onChange={(e) => handleConfigChange('agentUrl', e.target.value)}
                  />
                </div>
                <div className="form-group">
                  <label className="form-label" htmlFor="agent-timeout">Timeout (seconds)</label>
                  <input
                    id="agent-timeout"
                    type="number"
                    className="form-input"
                    min={10}
                    max={3600}
                    value={(node.data.config as any)?.timeout || 300}
                    onChange={(e) => handleConfigChange('timeout', e.target.value)}
                  />
                </div>
                <button
                  className="btn btn-outline"
                  style={{ width: '100%', marginTop: '8px' }}
                  onClick={async () => {
                    const url = (node.data.config as any)?.agentUrl;
                    if (!url) return alert('Enter an agent URL first');
                    try {
                      const res = await fetch(`${url}/.well-known/agent.json`);
                      if (res.ok) {
                        const card = await res.json();
                        handleConfigChange('agentName', card.name);
                        alert(`Discovered: ${card.name}\nSkills: ${card.skills?.map((s: any) => s.name).join(', ')}`);
                      } else {
                        alert('Agent not found at that URL');
                      }
                    } catch {
                      alert('Could not connect to agent');
                    }
                  }}
                >
                  🔍 Discover Agent
                </button>
              </>
            )}
          </>
        )}

        {activeTab === 'compute' && (
          <div className="compute-tab" style={{ display: 'flex', flexDirection: 'column', gap: '16px', padding: '16px' }}>
            <div className="form-group">
              <label className="form-label">Max Parallel Agents (Concurrency)</label>
              <input 
                type="range" 
                min={1} 
                max={8} 
                step={1}
                className="form-range"
                value={(node.data.config as any)?.maxConcurrency || 1}
                onChange={(e) => handleConfigChange('maxConcurrency', parseInt(e.target.value))}
              />
              <div style={{ fontSize: '11px', color: 'var(--text-tertiary)', marginTop: '4px' }}>
                Currently: {(node.data.config as any)?.maxConcurrency || 1} parallel calls
              </div>
            </div>

            <div className="form-group">
              <label className="form-label">Max Recursion Depth</label>
              <input 
                type="number" 
                min={0} 
                max={5}
                className="form-input"
                value={(node.data.config as any)?.recursionLimit || 2}
                onChange={(e) => handleConfigChange('recursionLimit', parseInt(e.target.value))}
              />
              <div style={{ fontSize: '11px', color: 'var(--text-tertiary)', marginTop: '4px' }}>
                Limit on how many times a task can be sub-divided.
              </div>
            </div>

            <div style={{ 
              padding: '12px', 
              background: 'rgba(59, 130, 246, 0.1)', 
              border: '1px solid rgba(59, 130, 246, 0.2)', 
              borderRadius: '6px',
              fontSize: '11px',
              color: '#60a5fa',
              lineHeight: 1.4
            }}>
              <strong>Laptop Safety Info:</strong>
              <p style={{ margin: '4px 0 0 0' }}>Keep concurrency low (1-2) when running large local models (like Llama-3-70B) to prevent system lag and OOM errors.</p>
            </div>
          </div>
        )}

        {activeTab === 'input' && (
          <div className="connections-list">
            {connections.inputs.length === 0 ? (
              <div className="empty-state">
                <ArrowLeft size={24} />
                <p>No incoming connections</p>
              </div>
            ) : (
              connections.inputs.map((inputNode) => (
                <div key={inputNode.id} className="connection-item">
                  <ArrowLeft size={16} />
                  <span>{String(inputNode.data.label || inputNode.type)}</span>
                </div>
              ))
            )}
            <div className="data-preview" style={{ marginTop: '16px' }}>
              <div className="data-preview-header">Input Schema</div>
              <div className="data-preview-content">
                {`{
  "messages": [...],
  "context": {...}
}`}
              </div>
            </div>
          </div>
        )}

        {activeTab === 'output' && (
          <div className="connections-list">
            {connections.outputs.length === 0 ? (
              <div className="empty-state">
                <ArrowRight size={24} />
                <p>No outgoing connections</p>
              </div>
            ) : (
              connections.outputs.map((outputNode) => (
                <div key={outputNode.id} className="connection-item">
                  <span>{String(outputNode.data.label || outputNode.type)}</span>
                  <ArrowRight size={16} />
                </div>
              ))
            )}
            <div className="data-preview" style={{ marginTop: '16px' }}>
              <div className="data-preview-header">Output Data</div>
              <div className="data-preview-content">
                {output ? JSON.stringify(output, null, 2) : 'No output yet. Execute the workflow to see results.'}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
