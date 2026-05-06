import { useState, useEffect, useRef } from 'react';
import { Brain, Upload, Zap, Loader, ChevronDown, ChevronUp, Book, Trash2, Database, AlertTriangle, CheckCircle, XCircle, Eye, BarChart3, Clock } from 'lucide-react';
import { useWorkspaceStore } from '../../hooks/useWorkspaceStore';
import { useLLMStatus } from '../../hooks/useLLMStatus';
import { API_BASE_URL, GOVERNANCE_HEADERS } from '../../constants';

interface SynthesisPanelProps {
  onGraphUpdated?: () => void;
}

interface IngestionProgress {
  run_id: string;
  status: 'connecting' | 'running' | 'completed' | 'error';
  message: string;
  current_section?: number;
  total_sections?: number;
  triples_extracted?: number;
  conflicts_found?: number;
  concepts_embedded?: number;
  total_concepts?: number;
  events: Array<{ event: string; message: string; timestamp: number }>;
}

interface TripleCard {
  subject: string;
  subject_type: string;
  predicate: string;
  object: string;
  object_type: string;
  citation: string;
  confidence: number;
  section_title?: string;
}

interface ConflictItem {
  concept_a: string;
  concept_b: string;
  description: string;
}

export const SynthesisPanel: React.FC<SynthesisPanelProps> = ({ onGraphUpdated }) => {
  const { 
    currentWorkspace, 
    activeLLMProvider, 
    setActiveLLMProvider, 
    activeLLMModels, 
    setActiveLLMModel,
    selectedDocuments, 
    toggleSelectedDocument, 
    setSynthesisResults 
  } = useWorkspaceStore();
  const { providers } = useLLMStatus(30000);
  const [ingestText, setIngestText] = useState('');
  const [sourceName, setSourceName] = useState('');
  const [loading, setLoading] = useState(false);
  const [localResults, setLocalResults] = useState<any>(null);
  const [isExpanded, setIsExpanded] = useState(true);
  const [embeddingProvider, setEmbeddingProvider] = useState('local');
  const [indexedDocs, setIndexedDocs] = useState<string[]>([]);
  const [mappedDocs, setMappedDocs] = useState<string[]>([]);
  const [synthesisDirection, setSynthesisDirection] = useState('');
  const [embeddingModel, setEmbeddingModel] = useState('nomic-embed-text-v1-GGUF');
  const [inferenceDelay, setInferenceDelay] = useState(2.0);

  // SSE Progress Tracking
  const [ingestionProgress, setIngestionProgress] = useState<IngestionProgress | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);

  // Triple Inspector & Conflict Resolution
  const [inspectTriples, setInspectTriples] = useState<TripleCard[]>([]);
  const [activeConflicts, setActiveConflicts] = useState<ConflictItem[]>([]);
  const [showTripleInspector, setShowTripleInspector] = useState(false);
  const [showConflictPanel, setShowConflictPanel] = useState(false);

  // Synthesis History
  const [showHistory, setShowHistory] = useState(false);
  const { synthesisHistory, fetchSynthesisHistory, deleteRun } = useWorkspaceStore();

  const fetchStatusAndMapped = async () => {
    try {
      const timestamp = Date.now();
      const [statusRes, mappedRes] = await Promise.all([
        fetch(`${API_BASE_URL}/api/rag/status?workspace=${currentWorkspace}`, {
          headers: { ...GOVERNANCE_HEADERS }
        }),
        fetch(`${API_BASE_URL}/api/graph/sources?workspace=${currentWorkspace}&t=${timestamp}`, {
          headers: { ...GOVERNANCE_HEADERS }
        })
      ]);
      
      if (statusRes.ok) {
        const data = await statusRes.json();
        setIndexedDocs(data.documents || []);
      }
      
      if (mappedRes.ok) {
        const data = await mappedRes.json();
        setMappedDocs(data.sources || []);
      }
    } catch (error) {
      console.error('Failed to fetch status:', error);
    }
  };

  useEffect(() => {
    fetchStatusAndMapped();
  }, [currentWorkspace]);

  // Cleanup SSE on unmount
  useEffect(() => {
    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }
    };
  }, []);

  const connectSSE = (runId: string) => {
    // Close any existing connection
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }

    const progress: IngestionProgress = {
      run_id: runId,
      status: 'connecting',
      message: 'Connecting to ingestion stream...',
      events: []
    };
    setIngestionProgress(progress);

    const es = new EventSource(`${API_BASE_URL}/api/graph/ingest/events/${runId}`);
    eventSourceRef.current = es;

    // Dispatch custom event for KnowledgeGraphCanvas to listen to
    window.dispatchEvent(new CustomEvent('benny:ingestion-started', { detail: { run_id: runId } }));

    const handleEvent = (eventType: string) => (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data);
        setIngestionProgress(prev => {
          if (!prev) return null;
          const updated = { ...prev };
          updated.status = 'running';
          updated.message = data.message || eventType;
          updated.events = [...prev.events, { event: eventType, message: data.message, timestamp: Date.now() }];

          if (data.data) {
            if (data.data.current !== undefined) updated.current_section = data.data.current;
            if (data.data.total !== undefined) updated.total_sections = data.data.total;
            if (data.data.count !== undefined) updated.triples_extracted = data.data.count;
            if (data.data.conflicts !== undefined) updated.conflicts_found = data.data.conflicts;
            if (data.data.completed !== undefined) updated.concepts_embedded = data.data.completed;
            if (data.data.total !== undefined && eventType === 'embedding_progress') updated.total_concepts = data.data.total;
          }

          if (eventType === 'completed') {
            updated.status = 'completed';
          } else if (eventType === 'error') {
            updated.status = 'error';
          }

          return updated;
        });
      } catch (err) {
        console.error('SSE parse error:', err);
      }
    };

    es.addEventListener('started', handleEvent('started'));
    es.addEventListener('section_progress', handleEvent('section_progress'));
    es.addEventListener('triples_extracted', handleEvent('triples_extracted'));
    es.addEventListener('conflicts_checked', handleEvent('conflicts_checked'));
    es.addEventListener('stored', handleEvent('stored'));
    es.addEventListener('embedding_progress', handleEvent('embedding_progress'));
    es.addEventListener('centrality_updated', handleEvent('centrality_updated'));
    es.addEventListener('completed', (e: MessageEvent) => {
      handleEvent('completed')(e);
      es.close();
      eventSourceRef.current = null;
      setLoading(false);
      fetchStatusAndMapped();
      if (onGraphUpdated) onGraphUpdated();
    });
    es.addEventListener('error', (e: MessageEvent) => {
      handleEvent('error')(e);
      es.close();
      eventSourceRef.current = null;
      setLoading(false);
    });

    es.onerror = () => {
      es.close();
      eventSourceRef.current = null;
      setLoading(false);
    };
  };

  const handleRemoveFromGraph = async (doc: string) => {
    if (!window.confirm(`Remove ${doc} from the Knowledge Graph? This deletes all its extracted triples.`)) return;
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE_URL}/api/graph/sources/${encodeURIComponent(doc)}?workspace=${currentWorkspace}`, {
        method: 'DELETE',
        headers: { ...GOVERNANCE_HEADERS }
      });
      if (res.ok) {
        if (onGraphUpdated) onGraphUpdated();
        await fetchStatusAndMapped();
        setLocalResults({ error: null, success_msg: `Removed ${doc} from graph.` });
      } else {
        setLocalResults({ error: "Failed to remove doc." });
      }
    } catch (err) {
      setLocalResults({ error: String(err) });
    } finally {
      setLoading(false);
    }
  };

  const handleIngest = async () => {
    if (!ingestText.trim()) return;
    setLoading(true);
    setLocalResults(null);
    setSynthesisResults(null);

    try {
      const res = await fetch(`${API_BASE_URL}/api/graph/ingest`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          ...GOVERNANCE_HEADERS
        },
        body: JSON.stringify({
          text: ingestText,
          source_name: sourceName || 'manual',
          workspace: currentWorkspace,
          provider: activeLLMProvider,
          model: activeLLMModels[activeLLMProvider],
          embed: true,
          embedding_provider: embeddingProvider,
          embedding_model: embeddingModel
        })
      });

      if (res.ok) {
        const data = await res.json();
        setLocalResults(data);
        setSynthesisResults(data);
        setIngestText('');
        setSourceName('');
        
        // Populate triple inspector and conflicts
        if (data.triples) {
          setInspectTriples(data.triples);
          setShowTripleInspector(true);
        }
        if (data.conflicts && data.conflicts.length > 0) {
          setActiveConflicts(data.conflicts);
          setShowConflictPanel(true);
        }
        
        await fetchStatusAndMapped();
        if (onGraphUpdated) onGraphUpdated();
      } else {
        const err = await res.text();
        setLocalResults({ error: err });
      }
    } catch (err) {
      setLocalResults({ error: String(err) });
    } finally {
      setLoading(false);
    }
  };

  const handleIngestFiles = async () => {
    if (selectedDocuments.length === 0) return;
    setLoading(true);
    setLocalResults(null);
    setSynthesisResults(null);
    setIngestionProgress(null);

    try {
      const res = await fetch(`${API_BASE_URL}/api/graph/ingest-files`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          ...GOVERNANCE_HEADERS
        },
        body: JSON.stringify({
          files: selectedDocuments,
          workspace: currentWorkspace,
          provider: activeLLMProvider,
          model: activeLLMModels[activeLLMProvider],
          embed: true,
          embedding_provider: embeddingProvider,
          embedding_model: embeddingModel,
          direction: synthesisDirection,
          inference_delay: inferenceDelay
        })
      });

      if (res.ok) {
        const data = await res.json();
        // Connect to SSE stream for real-time progress
        if (data.run_id) {
          connectSSE(data.run_id);
        }
        setLocalResults({ success_msg: `Ingestion started (${selectedDocuments.length} files). Streaming progress...` });
      } else {
        const err = await res.text();
        setLocalResults({ error: err });
        setLoading(false);
      }
    } catch (err) {
      setLocalResults({ error: String(err) });
      setLoading(false);
    }
  };

  const handleSynthesize = async () => {
    setLoading(true);
    setLocalResults(null);
    setSynthesisResults(null);

    try {
      const res = await fetch(`${API_BASE_URL}/api/graph/synthesize`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          ...GOVERNANCE_HEADERS
        },
        body: JSON.stringify({
          workspace: currentWorkspace,
          provider: activeLLMProvider,
          model: activeLLMModels[activeLLMProvider]
        })
      });

      if (res.ok) {
        const data = await res.json();
        setLocalResults(data);
        setSynthesisResults(data);
        if (onGraphUpdated) onGraphUpdated();
      } else {
        const err = await res.text();
        setLocalResults({ error: err });
      }
    } catch (err) {
      setLocalResults({ error: String(err) });
    } finally {
      setLoading(false);
    }
  };

  // Progress bar percentage
  const progressPct = ingestionProgress?.current_section && ingestionProgress?.total_sections
    ? Math.round((ingestionProgress.current_section / ingestionProgress.total_sections) * 100)
    : 0;

  return (
    <div className="synthesis-panel">
      <button 
        className="synthesis-panel-header"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Brain size={16} style={{ color: 'var(--primary)' }} />
          <span>Synthesis Engine</span>
        </div>
        {isExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
      </button>

      {isExpanded && (
        <div className="synthesis-panel-body">
          {/* Text Ingestion */}
          <div className="synthesis-section">
            <label className="synthesis-label">
              <Upload size={12} /> Ingest Text → Triples
            </label>
            <input
              type="text"
              value={sourceName}
              onChange={(e) => setSourceName(e.target.value)}
              placeholder="Source name (e.g. research_paper.pdf)"
              className="synthesis-input"
            />
            <textarea
              value={ingestText}
              onChange={(e) => setIngestText(e.target.value)}
              placeholder="Paste text to extract knowledge triples..."
              className="synthesis-textarea"
              rows={4}
            />
            <div className="synthesis-row" style={{ display: 'flex', gap: '8px', marginBottom: '12px' }}>
              <div style={{ flex: 1 }}>
                <select
                  value={embeddingProvider}
                  onChange={(e) => setEmbeddingProvider(e.target.value)}
                  className="synthesis-select"
                  style={{ width: '100%' }}
                >
                  <option value="local">Local Embedding (Lemonade/Ollama)</option>
                  <option value="openai">OpenAI Embedding</option>
                </select>
              </div>
              <div style={{ flex: 1 }}>
                <input 
                  type="text" 
                  value={embeddingModel} 
                  onChange={(e) => setEmbeddingModel(e.target.value)} 
                  className="synthesis-input" 
                  placeholder="Embedding Model (e.g. nomic-embed-text)"
                  title="Embedding Model Name"
                />
              </div>
            </div>
            <div className="synthesis-row">
              <button
                className="btn btn-gradient"
                onClick={handleIngest}
                disabled={loading || !ingestText.trim()}
              >
                {loading ? <Loader size={14} className="animate-spin" /> : <Upload size={14} />}
                Extract
              </button>
            </div>
          </div>

          {/* Indexed Document Selection */}
          <div className="synthesis-section">
            <label className="synthesis-label">
              <Book size={12} /> Select Indexed Docs
            </label>
            <div className="synthesis-doc-list">
              {indexedDocs.length === 0 ? (
                <div className="synthesis-no-docs">No indexed documents found.</div>
              ) : (
                indexedDocs.map(doc => {
                  const isMapped = mappedDocs.includes(doc);
                  return (
                    <div key={doc} className="synthesis-doc-item" onClick={() => toggleSelectedDocument(doc)}>
                      <input 
                        type="checkbox"
                        checked={selectedDocuments.includes(doc)}
                        onChange={(e) => {
                          e.stopPropagation();
                          toggleSelectedDocument(doc);
                        }}
                        style={{ cursor: 'pointer' }}
                        title={`Select ${doc}`}
                      />
                      <span className="synthesis-doc-name">{doc}</span>
                      {isMapped && (
                        <span className="synthesis-doc-badge">
                          <Database size={10} /> Mapped
                        </span>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </div>

          {/* Batch File Ingestion */}
          {selectedDocuments.length > 0 && (
            <div className="synthesis-section highlight">
              <label className="synthesis-label" style={{ color: 'var(--primary)' }}>
                <Brain size={12} /> Workspace Mapping
              </label>
              <p style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '8px' }}>
                Create knowledge map for {selectedDocuments.length} selected document{selectedDocuments.length !== 1 ? 's' : ''}.
                <br/>
                <strong>LLM Model:</strong> {activeLLMModels[activeLLMProvider] || 'Default'}
              </p>
              
              <div style={{ display: 'flex', gap: '8px', marginBottom: '8px' }}>
                <div style={{ flex: 1 }}>
                  <label style={{ fontSize: '10px', color: 'var(--text-muted)' }}>LLM Provider</label>
                  <select
                    value={activeLLMProvider}
                    onChange={(e) => setActiveLLMProvider(e.target.value)}
                    className="synthesis-select"
                    style={{ width: '100%' }}
                    title="Select LLM Provider"
                    aria-label="Select LLM Provider"
                  >
                    {Object.entries(providers).map(([id, p]) => (
                      <option key={id} value={id}>{p.name} {p.running ? '\u25cf' : '\u25cb'}</option>
                    ))}
                    <optgroup label="Cloud">
                      <option value="openai">OpenAI</option>
                      <option value="anthropic">Anthropic</option>
                    </optgroup>
                  </select>
                </div>
                <div style={{ flex: 1 }}>
                  <label style={{ fontSize: '10px', color: 'var(--text-muted)' }}>Model</label>
                  <select
                    value={activeLLMModels[activeLLMProvider] || ''}
                    onChange={(e) => setActiveLLMModel(activeLLMProvider, e.target.value)}
                    className="synthesis-select"
                    style={{ width: '100%' }}
                    title="Select Model"
                    aria-label="Select Model"
                  >
                    {!providers[activeLLMProvider] ? (
                       <option value="">Loading models...</option>
                    ) : providers[activeLLMProvider]?.models?.data?.length > 0 ? (
                      providers[activeLLMProvider].models.data.map((m: any) => (
                        <option key={m.id} value={m.id}>
                          {m.id} {m.status === 'fallback' ? '(NPU Fallback)' : ''}
                        </option>
                      ))
                    ) : (
                      <optgroup label="Default Fallbacks">
                        <option value="gpt-4-turbo">GPT-4 Turbo</option>
                        <option value="claude-3-sonnet">Claude 3 Sonnet</option>
                      </optgroup>
                    )}
                  </select>
                </div>
              </div>

              <div style={{ display: 'flex', gap: '8px', marginBottom: '8px' }}>
                <div style={{ flex: '0 0 100px' }}>
                  <label style={{ fontSize: '10px', color: 'var(--text-muted)' }}>Delay (s)</label>
                  <input 
                    type="number" 
                    value={inferenceDelay} 
                    onChange={(e) => setInferenceDelay(parseFloat(e.target.value) || 0)} 
                    className="synthesis-input"
                    step="0.5"
                    min="0"
                    title="Inference Delay to prevent hardware throttling"
                  />
                </div>
                <div style={{ flex: 1 }}>
                  <label style={{ fontSize: '10px', color: 'var(--text-muted)' }}>Synthesis Direction</label>
                  <input
                    type="text"
                    value={synthesisDirection}
                    onChange={(e) => setSynthesisDirection(e.target.value)}
                    placeholder="e.g. 'Extract points on how to train an AI agent'"
                    className="synthesis-input"
                  />
                </div>
              </div>
              <button
                className="btn btn-gradient synthesis-btn-full mt-2"
                onClick={handleIngestFiles}
                disabled={loading}
                style={{ background: 'linear-gradient(135deg, #a88bfa, #8b5cf6)' }}
              >
                {loading ? <Loader size={14} className="animate-spin" /> : <Brain size={14} />}
                Map Selected Documents ({selectedDocuments.length})
              </button>
            </div>
          )}

          {/* SSE Progress Bar */}
          {ingestionProgress && (
            <div className="synthesis-section" style={{
              background: ingestionProgress.status === 'error' ? 'rgba(239,68,68,0.05)' : 'rgba(139,92,246,0.05)',
              border: `1px solid ${ingestionProgress.status === 'error' ? 'rgba(239,68,68,0.2)' : 'rgba(139,92,246,0.2)'}`,
              borderRadius: '8px',
              padding: '12px'
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                {ingestionProgress.status === 'running' && <Loader size={14} className="animate-spin" style={{ color: 'var(--primary)' }} />}
                {ingestionProgress.status === 'completed' && <CheckCircle size={14} style={{ color: '#10b981' }} />}
                {ingestionProgress.status === 'error' && <XCircle size={14} style={{ color: '#ef4444' }} />}
                <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-primary)' }}>
                  {ingestionProgress.status === 'completed' ? 'Ingestion Complete' : 
                   ingestionProgress.status === 'error' ? 'Ingestion Failed' : 'Ingesting...'}
                </span>
              </div>

              {/* Determinate progress bar */}
              {ingestionProgress.total_sections && ingestionProgress.total_sections > 0 && (
                <div style={{ marginBottom: '8px' }}>
                  <div style={{
                    height: '6px', background: 'rgba(139,92,246,0.15)', borderRadius: '3px',
                    overflow: 'hidden'
                  }}>
                    <div style={{
                      height: '100%', width: `${progressPct}%`,
                      background: 'linear-gradient(90deg, #8b5cf6, #a78bfa)',
                      borderRadius: '3px',
                      transition: 'width 0.3s ease'
                    }} />
                  </div>
                  <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '4px' }}>
                    Section {ingestionProgress.current_section}/{ingestionProgress.total_sections}
                    {ingestionProgress.triples_extracted !== undefined && (
                      <span> · {ingestionProgress.triples_extracted} triples</span>
                    )}
                    {ingestionProgress.conflicts_found !== undefined && ingestionProgress.conflicts_found > 0 && (
                      <span style={{ color: '#f59e0b' }}> · {ingestionProgress.conflicts_found} conflicts</span>
                    )}
                  </div>
                </div>
              )}

              {/* Latest event message */}
              <div style={{ fontSize: '10px', color: 'var(--text-secondary)' }}>
                {ingestionProgress.message}
              </div>

              {/* Embedding progress */}
              {ingestionProgress.concepts_embedded !== undefined && ingestionProgress.total_concepts && (
                <div style={{ marginTop: '6px', fontSize: '10px', color: '#10b981' }}>
                  Embedded {ingestionProgress.concepts_embedded}/{ingestionProgress.total_concepts} concepts
                </div>
              )}
            </div>
          )}

          {/* Synthesis Trigger */}
          <div className="synthesis-section">
            <label className="synthesis-label">
              <Zap size={12} /> Run Synthesis (Find Analogies)
            </label>
            <button
              className="btn btn-gradient synthesis-btn-full"
              onClick={handleSynthesize}
              disabled={loading}
            >
              {loading ? <Loader size={14} className="animate-spin" /> : <Zap size={14} />}
              Discover Structural Isomorphisms
            </button>
          </div>

          {/* Synthesis History Button */}
          <div className="synthesis-section">
            <button
              className="btn btn-ghost synthesis-btn-full"
              onClick={() => { setShowHistory(!showHistory); if (!showHistory) fetchSynthesisHistory(); }}
              style={{ fontSize: '11px', display: 'flex', alignItems: 'center', gap: '6px', justifyContent: 'center' }}
            >
              <Clock size={12} /> {showHistory ? 'Hide' : 'Show'} Synthesis History
            </button>

            {showHistory && synthesisHistory.length > 0 && (
              <div style={{ marginTop: '8px', maxHeight: '200px', overflowY: 'auto' }}>
                {synthesisHistory.map((run: any, idx: number) => (
                  <div key={run.run_id || idx} style={{
                    padding: '8px', background: 'rgba(0,0,0,0.1)', borderRadius: '6px',
                    marginBottom: '4px', fontSize: '10px', display: 'flex', justifyContent: 'space-between', alignItems: 'center'
                  }}>
                    <div>
                      <div style={{ color: 'var(--text-primary)', fontWeight: 600 }}>
                        {run.files?.join(', ') || 'Unknown'}
                      </div>
                      <div style={{ color: 'var(--text-muted)', marginTop: '2px' }}>
                        {run.model || 'default'} · {run.created_at ? new Date(run.created_at).toLocaleDateString() : ''}
                      </div>
                    </div>
                    <button
                      className="btn-icon btn-ghost danger"
                      onClick={() => deleteRun(run.run_id)}
                      title="Delete run"
                    >
                      <Trash2 size={10} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Manage Mapped Documents */}
          {mappedDocs.length > 0 && (
            <div className="synthesis-section">
              <label className="synthesis-label text-muted">
                <Database size={12} /> Graph Assets
              </label>
              <div className="synthesis-doc-list mt-0">
                {mappedDocs.map(doc => (
                  <div key={doc} className="synthesis-doc-item read-only">
                    <span className="synthesis-doc-name">{doc}</span>
                    <button 
                      className="btn-icon btn-ghost danger" 
                      onClick={() => handleRemoveFromGraph(doc)}
                      title="Remove from graph"
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Results */}
          {localResults && (
            <div className="synthesis-results">
              {localResults.error ? (
                <div className="synthesis-error" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <XCircle size={14} /> {localResults.error}
                </div>
              ) : (
                <>
                  {localResults.success_msg && (
                    <div className="synthesis-stat success" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <CheckCircle size={12} /> {localResults.success_msg}
                    </div>
                  )}
                  {localResults.triples_extracted !== undefined && (
                    <div className="synthesis-stat" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <CheckCircle size={12} /> {localResults.triples_extracted} triples extracted, {localResults.triples_stored} stored
                      {localResults.triples && localResults.triples.length > 0 && (
                        <button
                          className="btn-ghost"
                          onClick={() => { setInspectTriples(localResults.triples); setShowTripleInspector(!showTripleInspector); }}
                          style={{ marginLeft: 'auto', fontSize: '10px', color: 'var(--primary)' }}
                        >
                          <Eye size={10} /> {showTripleInspector ? 'Hide' : 'Inspect'}
                        </button>
                      )}
                    </div>
                  )}
                  {localResults.conflicts_detected > 0 && (
                    <div className="synthesis-stat conflict" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <AlertTriangle size={12} /> {localResults.conflicts_detected} conflicts detected
                      <button
                        className="btn-ghost"
                        onClick={() => { setActiveConflicts(localResults.conflicts || []); setShowConflictPanel(!showConflictPanel); }}
                        style={{ marginLeft: 'auto', fontSize: '10px', color: '#f59e0b' }}
                      >
                        {showConflictPanel ? 'Hide' : 'Resolve'}
                      </button>
                    </div>
                  )}
                  {localResults.concepts_embedded > 0 && (
                    <div className="synthesis-stat" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <BarChart3 size={12} /> {localResults.concepts_embedded} concepts embedded
                    </div>
                  )}
                  {localResults.analogies_found !== undefined && (
                    <div className="synthesis-stat" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <Zap size={12} /> {localResults.analogies_found} analogies discovered
                    </div>
                  )}

                  {/* Triple Inspector */}
                  {showTripleInspector && inspectTriples.length > 0 && (
                    <div style={{ marginTop: '8px', maxHeight: '300px', overflowY: 'auto' }}>
                      <label style={{ fontSize: '10px', color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                        Triple Inspector ({inspectTriples.length})
                      </label>
                      {inspectTriples.map((t: any, i: number) => (
                        <div key={i} style={{
                          padding: '8px', background: 'rgba(139,92,246,0.05)', borderRadius: '6px',
                          border: '1px solid rgba(139,92,246,0.12)', marginTop: '4px', fontSize: '11px'
                        }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                            <span className="triple-subject" style={{ 
                              background: 'rgba(165,110,255,0.1)', padding: '1px 6px', borderRadius: '4px', fontWeight: 600
                            }}>{t.subject}</span>
                            <span className="triple-predicate" style={{ 
                              color: '#818cf8', fontStyle: 'italic' 
                            }}>{t.predicate}</span>
                            <span className="triple-object" style={{ 
                              background: 'rgba(77,187,255,0.1)', padding: '1px 6px', borderRadius: '4px', fontWeight: 600
                            }}>{t.object}</span>
                          </div>
                          {t.confidence !== undefined && (
                            <div style={{ marginTop: '4px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                              <div style={{
                                height: '3px', flex: 1, background: 'rgba(255,255,255,0.1)', borderRadius: '2px',
                                overflow: 'hidden'
                              }}>
                                <div style={{
                                  height: '100%', width: `${(t.confidence || 0) * 100}%`,
                                  background: t.confidence > 0.7 ? '#10b981' : t.confidence > 0.4 ? '#f59e0b' : '#ef4444',
                                  borderRadius: '2px'
                                }} />
                              </div>
                              <span style={{ fontSize: '9px', color: 'var(--text-muted)' }}>
                                {Math.round((t.confidence || 0) * 100)}%
                              </span>
                            </div>
                          )}
                          {t.citation && (
                            <div style={{ fontSize: '9px', color: 'var(--text-muted)', marginTop: '3px', fontStyle: 'italic' }}>
                              "{t.citation.substring(0, 120)}{t.citation.length > 120 ? '...' : ''}"
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Conflict Resolution Panel */}
                  {showConflictPanel && activeConflicts.length > 0 && (
                    <div style={{ marginTop: '8px' }}>
                      <label style={{ fontSize: '10px', color: '#f59e0b', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                        Conflict Resolution ({activeConflicts.length})
                      </label>
                      {activeConflicts.map((c, i) => (
                        <div key={i} style={{
                          padding: '8px', background: 'rgba(245,158,11,0.05)', borderRadius: '6px',
                          border: '1px solid rgba(245,158,11,0.2)', marginTop: '4px', fontSize: '11px'
                        }}>
                          <div style={{ fontWeight: 600, color: 'var(--text-primary)' }}>
                            {c.concept_a} ↔ {c.concept_b}
                          </div>
                          <div style={{ color: 'var(--text-secondary)', marginTop: '2px' }}>
                            {c.description}
                          </div>
                          <div style={{ display: 'flex', gap: '6px', marginTop: '6px' }}>
                            <button 
                              className="btn-ghost" 
                              style={{ fontSize: '9px', color: '#10b981', padding: '2px 8px', border: '1px solid rgba(16,185,129,0.3)', borderRadius: '4px' }}
                              onClick={() => {
                                setActiveConflicts(prev => prev.filter((_, idx) => idx !== i));
                              }}
                            >
                              <CheckCircle size={10} /> Accept
                            </button>
                            <button 
                              className="btn-ghost" 
                              style={{ fontSize: '9px', color: '#ef4444', padding: '2px 8px', border: '1px solid rgba(239,68,68,0.3)', borderRadius: '4px' }}
                              onClick={() => {
                                setActiveConflicts(prev => prev.filter((_, idx) => idx !== i));
                              }}
                            >
                              <XCircle size={10} /> Reject
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  {localResults.analogies && localResults.analogies.length > 0 && (
                    <div className="synthesis-analogies">
                      {localResults.analogies.map((a: any, i: number) => (
                        <div key={i} className="analogy-item">
                          <strong>{a.concept_a} ↔ {a.concept_b}</strong>
                          <p>{a.description}</p>
                          <span className="pattern-tag">Pattern: {a.pattern}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default SynthesisPanel;
