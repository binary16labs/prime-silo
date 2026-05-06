import { useState, useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { 
  Upload, File, FileText, Trash2, Loader, Download, Terminal, Link, Book, 
  ShieldCheck, Zap, Info, RefreshCw
} from 'lucide-react';
import { useWorkspaceStore } from '../../hooks/useWorkspaceStore';
import { API_BASE_URL, GOVERNANCE_HEADERS } from '../../constants';

interface SourceFile {
  name: string;
  path: string;
  size: number;
  modified?: number;
}

export default function DataManagementPanel() {
  const { currentWorkspace, setActiveDocument, selectedDocuments, toggleSelectedDocument } = useWorkspaceStore();
  const [inFiles, setInFiles] = useState<SourceFile[]>([]);
  const [outFiles, setOutFiles] = useState<SourceFile[]>([]);
  const [stagedFiles, setStagedFiles] = useState<SourceFile[]>([]);
  const [indexedFiles, setIndexedFiles] = useState<string[]>([]);
  const [activeSources, setActiveSources] = useState<Set<string>>(new Set());
  const [uploading, setUploading] = useState(false);
  const [ingesting, setIngesting] = useState(false);
  const [showLogs, setShowLogs] = useState(false);
  const [activeTasks, setActiveTasks] = useState<any[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const [batchSize, setBatchSize] = useState(500);
  const [ingestionStrategy, setIngestionStrategy] = useState<'safe' | 'aggressive'>('safe');
  const [deepSynthesis, setDeepSynthesis] = useState(true);
  const [correlationThreshold, setCorrelationThreshold] = useState(0.70);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const logsEndRef = useRef<HTMLDivElement>(null);

  // Poll for tasks when ingesting or when showLogs is true
  const { data: logsData } = useQuery({
    queryKey: ['ragLogs', currentWorkspace],
    queryFn: async () => {
      const res = await fetch(`${API_BASE_URL}/api/rag/logs?workspace=${currentWorkspace}`, {
        headers: { ...GOVERNANCE_HEADERS }
      });
      return res.json();
    },
    refetchInterval: (query) => (ingesting || showLogs) ? 1000 : false,
    enabled: ingesting || showLogs
  });

  // Graph Health Query (C.1.3)
  const { data: healthData, refetch: refetchHealth } = useQuery({
    queryKey: ['graphHealth', currentWorkspace],
    queryFn: async () => {
      const res = await fetch(`${API_BASE_URL}/api/graph/health?workspace=${currentWorkspace}`, {
        headers: { ...GOVERNANCE_HEADERS }
      });
      return res.json();
    },
    refetchInterval: 10000, // Refresh every 10s
    enabled: !!currentWorkspace
  });

  const [showRecommendations, setShowRecommendations] = useState(false);

  useEffect(() => {
    if (logsData?.tasks) {
      setActiveTasks(logsData.tasks);
      const isAnyRunning = logsData.tasks.some((t: any) => t.status === 'running');
      if (!isAnyRunning && ingesting) {
        setIngesting(false);
        fetchIndexedStatus();
      }
      logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    } else if (!ingesting && !showLogs) {
      setActiveTasks([]);
    }
  }, [logsData, ingesting, showLogs]);

  // Refresh files when workspace changes
  useEffect(() => {
    fetchFiles();
    fetchIndexedStatus();
    setActiveSources(new Set()); // Reset active selection
  }, [currentWorkspace]);

  const fetchIndexedStatus = async () => {
    try {
      const response = await fetch(`${API_BASE_URL}/api/rag/status?workspace=${currentWorkspace}`, {
        headers: { ...GOVERNANCE_HEADERS }
      });
      if (!response.ok) return;
      const data = await response.json();
      setIndexedFiles(data.sources || data.documents || []);

    } catch (error) {
       console.error('Failed to fetch indexed status:', error);
    }
  };

  const fetchFiles = async () => {
    try {
      const response = await fetch(`${API_BASE_URL}/api/files?workspace=${currentWorkspace}`, {
        headers: { ...GOVERNANCE_HEADERS }
      });
      const data = await response.json();
      setInFiles(data.data_in || []);
      setOutFiles(data.data_out || []);
      setStagedFiles(data.staging || []);
    } catch (error) {
      console.error('Failed to fetch files:', error);
    }
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDragActive(false);
    const files = Array.from(e.dataTransfer.files);
    await processAndUploadFiles(files);
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    await processAndUploadFiles(files);
  };

  const processAndUploadFiles = async (files: File[]) => {
    if (files.length === 0) return;

    const shouldIndex = window.confirm(
      `You are uploading ${files.length} document(s).\n\nWould you like to automatically index them for the AI agent now?\n\n(Note: This offloads the indexing process to the background, and will automatically perform OCR on scanned PDFs).`
    );

    setUploading(true);
    let uploadedCurrent = [];

    for (const file of files) {
      const formData = new FormData();
      formData.append('file', file);
      try {
        if (file.name.toLowerCase().endsWith('.pdf')) {
          const res = await fetch(`${API_BASE_URL}/api/etl/stage-and-convert?workspace=${currentWorkspace}`, {
            method: 'POST',
            headers: { ...GOVERNANCE_HEADERS },
            body: formData
          });
          const data = await res.json();
          uploadedCurrent.push(data.markdown_filename);
        } else {
          await fetch(`${API_BASE_URL}/api/files/upload?workspace=${currentWorkspace}`, {
            method: 'POST',
            headers: { ...GOVERNANCE_HEADERS },
            body: formData
          });
          uploadedCurrent.push(file.name);
        }
      } catch (error) {
        console.error('Upload failed:', error);
      }
    }

    await fetchFiles();
    setUploading(false);

    if (shouldIndex && uploadedCurrent.length > 0) {
      setIngesting(true);
      try {
        await fetch(`${API_BASE_URL}/api/rag/ingest`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            workspace: currentWorkspace,
            files: uploadedCurrent,
            batch_size: batchSize,
            strategy: ingestionStrategy,
            deep_synthesis: deepSynthesis,
            correlation_threshold: correlationThreshold
          })
        });
        alert('Files uploaded and indexed successfully!');
      } catch (error) {
        console.error('Ingestion failed:', error);
        alert('Upload succeeded, but ingestion failed. You can retry indexing manually.');
      } finally {
        setIngesting(false);
      }
    }
  };

  const deleteFile = async (filename: string, subdir: string) => {
    try {
      await fetch(`${API_BASE_URL}/api/files/${filename}?workspace=${currentWorkspace}&subdir=${subdir}`, {
        method: 'DELETE',
        headers: { ...GOVERNANCE_HEADERS }
      });
      fetchFiles();
      const newActive = new Set(activeSources);
      newActive.delete(filename);
      setActiveSources(newActive);
    } catch (error) {
      console.error('Delete failed:', error);
    }
  };

  const importFromUrl = async () => {
    const url = window.prompt("Enter the URL to import (e.g. Gutenberg Book HTML URL):");
    if (!url) return;

    setUploading(true);
    let uploadedFile = null;
    try {
      const res = await fetch(`${API_BASE_URL}/api/files/download-url`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          ...GOVERNANCE_HEADERS
        },
        body: JSON.stringify({ url, workspace: currentWorkspace })
      });
      if (!res.ok) throw new Error("Download failed");
      const data = await res.json();
      uploadedFile = data.filename;
    } catch (e: any) {
      console.error(e);
      alert("Failed to download from URL: " + e.message);
    }
    setUploading(false);
    await fetchFiles();

    if (uploadedFile) {
      const shouldIndex = window.confirm(`Successfully imported ${uploadedFile}. Would you like to index it for the AI agent now?`);
      if (shouldIndex) {
        setIngesting(true);
        try {
          await fetch(`${API_BASE_URL}/api/rag/ingest`, {
            method: 'POST',
            headers: { 
              'Content-Type': 'application/json',
              ...GOVERNANCE_HEADERS
            },
            body: JSON.stringify({ 
              workspace: currentWorkspace,
              files: [uploadedFile],
              batch_size: batchSize
            })
          });
          alert('File imported and indexed successfully!');
        } catch (error) {
          console.error('Ingestion failed:', error);
          alert('Import succeeded, but ingestion failed. You can retry indexing manually.');
        } finally {
          setIngesting(false);
        }
      }
    }
  };

  const importFromGutenberg = async () => {
    const url = window.prompt("Enter the Gutenberg Book TXT URL to import (e.g. .../pg76432.txt):");
    if (!url) return;

    setUploading(true);
    let uploadedFile = null;
    try {
      const res = await fetch(`${API_BASE_URL}/api/files/download-gutenberg`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          ...GOVERNANCE_HEADERS
        },
        body: JSON.stringify({ url, workspace: currentWorkspace })
      });
      if (!res.ok) throw new Error("Download failed");
      const data = await res.json();
      uploadedFile = data.filename;
    } catch (e: any) {
      console.error(e);
      alert("Failed to download from Gutenberg: " + e.message);
    }
    setUploading(false);
    await fetchFiles();

    if (uploadedFile) {
      const shouldIndex = window.confirm(`Successfully imported Gutenberg Book as ${uploadedFile}. Would you like to index it for the AI agent now?`);
      if (shouldIndex) {
        setIngesting(true);
        try {
          await fetch(`${API_BASE_URL}/api/rag/ingest`, {
            method: 'POST',
            headers: { 
              'Content-Type': 'application/json',
              ...GOVERNANCE_HEADERS
            },
            body: JSON.stringify({ 
              workspace: currentWorkspace,
              files: [uploadedFile],
              batch_size: batchSize,
              strategy: ingestionStrategy
            })
          });
          alert('Gutenberg Book imported and indexed successfully!');
        } catch (error) {
          console.error('Ingestion failed:', error);
          alert('Import succeeded, but ingestion failed. You can retry indexing manually.');
        } finally {
          setIngesting(false);
        }
      }
    }
  };
  
  const downloadFile = async (filename: string, subdir: string) => {
    try {
      const response = await fetch(`${API_BASE_URL}/api/files/${currentWorkspace}/${subdir}/${filename}`, {
        headers: { ...GOVERNANCE_HEADERS }
      });
      if (!response.ok) throw new Error('Download failed');
      
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch (error) {
      console.error('Download failed:', error);
      alert('Failed to download file');
    }
  };

  const toggleActive = (filename: string) => {
    const newActive = new Set(activeSources);
    if (newActive.has(filename)) {
      newActive.delete(filename);
    } else {
      newActive.add(filename);
    }
    setActiveSources(newActive);
  };

  const ingestFiles = async () => {
    if (activeSources.size === 0) return;
    setIngesting(true);
    try {
      await fetch(`${API_BASE_URL}/api/rag/ingest`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          ...GOVERNANCE_HEADERS
        },
        body: JSON.stringify({ 
          workspace: currentWorkspace,
          files: Array.from(activeSources),
          batch_size: batchSize,
          strategy: ingestionStrategy,
          deep_synthesis: deepSynthesis,
          correlation_threshold: correlationThreshold
        })
      });
      alert(`Successfully indexed ${activeSources.size} file(s)!`);
      fetchIndexedStatus();
      setActiveSources(new Set());
    } catch (error) {
      console.error('Ingestion failed:', error);
      alert('Ingestion failed');
    } finally {
      setIngesting(false);
    }
  };

  const handleForceCorrelate = async () => {
    setIngesting(true);
    try {
      const resp = await fetch(`${API_BASE_URL}/api/rag/correlate?workspace=${currentWorkspace}&threshold=${correlationThreshold}`, {
        method: 'POST',
        headers: { ...GOVERNANCE_HEADERS }
      });
      const data = await resp.json();
      alert(`Manual Correlation Suite finished!\nSafe Links: ${data.results?.safe_links}\nAggressive: ${data.results?.aggressive_links}`);
    } catch (e) {
      console.error(e);
      alert('Correlation Suite failed');
    } finally {
      setIngesting(false);
    }
  };

  const getFileIcon = (filename: string) => {
    const ext = filename.split('.').pop()?.toLowerCase();
    if (ext === 'pdf') return <File size={20} style={{ color: '#ef4444' }} />;
    if (ext === 'md') return <FileText size={20} style={{ color: '#3b82f6' }} />;
    return <FileText size={20} style={{ color: '#10b981' }} />;
  };

  const IngestionDashboard = ({ task }: { task: any }) => {
    const stages = ["EXTRACTING", "INDEXING", "GRAPH_MAPPING"];
    const currentStage = task.metadata?.stage || "EXTRACTING";
    const currentIndex = stages.indexOf(currentStage);

    return (
      <div className="ingestion-dashboard glass-card" style={{ padding: '16px', borderRadius: '12px', border: '1px solid var(--border-color)', background: 'rgba(0,0,0,0.2)', marginBottom: '16px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
           <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
             <Loader className="animate-spin" size={16} style={{ color: 'var(--primary)' }} />
             <span style={{ fontSize: '13px', fontWeight: 'bold', color: 'var(--text-primary)' }}>Cognitive Inquisitor Active</span>
           </div>
           <div className={`status-tag ${task.status === 'completed' ? 'indexed' : 'meta'}`} style={{ fontSize: '10px' }}>
             {task.status.toUpperCase()}
           </div>
        </div>

        <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '12px' }}>
          {task.message}
        </div>

        {/* Multi-Stage Progress Bar */}
        <div style={{ display: 'flex', gap: '4px', height: '6px', marginBottom: '16px' }}>
          {stages.map((stage, i) => {
            const isDone = i < currentIndex;
            const isCurrent = i === currentIndex;
            return (
              <div 
                key={stage} 
                className="progress-segment"
                style={{ 
                  flex: 1, 
                  background: isDone ? 'var(--primary)' : isCurrent ? 'rgba(168, 139, 250, 0.3)' : 'rgba(255,255,255,0.05)',
                  borderRadius: '3px',
                  overflow: 'hidden',
                  position: 'relative'
                }}
              >
                {isCurrent && (
                  <div 
                    className="progress-shimmer" 
                    style={{ 
                      position: 'absolute', 
                      inset: 0, 
                      width: `${task.progress % 100}%`, 
                      background: 'var(--primary)',
                      transition: 'width 0.3s ease'
                    }} 
                  />
                )}
              </div>
            );
          })}
        </div>

        {/* Stage Labels */}
        <div style={{ display: 'flex', justifyContent: 'space-between', textAlign: 'center' }}>
          {stages.map((stage, i) => (
            <div key={stage} style={{ flex: 1, fontSize: '9px', fontWeight: 'bold', color: i <= currentIndex ? 'var(--text-primary)' : 'var(--text-muted)', textTransform: 'uppercase' }}>
              {stage.replace('_', ' ')}
            </div>
          ))}
        </div>

        {/* Metrics Grid */}
        <div style={{ display: 'flex', gap: '12px', marginTop: '16px', paddingTop: '12px', borderTop: '1px solid rgba(255,255,255,0.05)' }}>
           <div style={{ flex: 1 }}>
              <div style={{ fontSize: '10px', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Chunks</div>
              <div style={{ fontSize: '16px', fontWeight: 'bold', color: 'var(--primary)' }}>{task.metadata?.indexed_count || 0}<span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>/{task.metadata?.chunks || '?'}</span></div>
           </div>
           <div style={{ flex: 1 }}>
              <div style={{ fontSize: '10px', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Triples</div>
              <div style={{ fontSize: '16px', fontWeight: 'bold', color: '#10b981' }}>{task.metadata?.triples || 0}</div>
           </div>
        </div>
      </div>
    );
  };

  const HealthGradeBadge = () => {
    if (!healthData) return null;
    return (
      <div className="flex flex-col gap-2">
        <div 
          className="glass-card flex items-center justify-between p-3 rounded-xl border cursor-pointer hover:bg-white/5 transition-all"
          style={{ borderColor: healthData.grade_color + '40', background: 'rgba(0,0,0,0.2)' }}
          onClick={() => setShowRecommendations(!showRecommendations)}
        >
          <div className="flex items-center gap-3">
            <div 
              className="flex items-center justify-center w-10 h-10 rounded-full font-bold text-xl border-2"
              style={{ color: healthData.grade_color, borderColor: healthData.grade_color }}
            >
              {healthData.grade}
            </div>
            <div className="flex flex-col">
              <span className="text-[10px] font-bold text-white/40 uppercase tracking-widest">Neural Nexus Health</span>
              <span className="text-[13px] font-semibold text-white/90">Score: {healthData.score}</span>
            </div>
          </div>
          <div className="flex items-center gap-2">
             <div className="flex flex-col items-end">
                <span className="text-[9px] font-bold text-white/30 uppercase">Schema Mode</span>
                <span className="text-[10px] font-mono text-white/60">{healthData.schema_mode}</span>
             </div>
             <Info size={16} className="text-white/20" />
          </div>
        </div>

        {showRecommendations && (
          <div className="glass-card p-4 rounded-xl border border-white/10 bg-black/40 animate-in fade-in slide-in-from-top-2">
             <div className="text-[10px] font-bold text-white/60 uppercase mb-3 border-b border-white/5 pb-2">Remediation Roadmap</div>
             <div className="flex flex-col gap-2">
                {healthData.recommendations?.map((rec: string, i: number) => (
                  <div key={i} className="flex gap-2 text-[11px] text-white/80 leading-relaxed">
                    <span className="text-primary text-[14px]">›</span>
                    {rec}
                  </div>
                ))}
             </div>
             
             <div className="mt-4 grid grid-cols-2 gap-2">
                <div className="p-2 rounded-lg bg-white/5 border border-white/5">
                   <div className="text-[8px] text-white/40 uppercase font-bold">Semantic Density</div>
                   <div className="text-[14px] font-mono font-bold text-[#10b981]">{healthData.score_components?.semantic_density_pct}%</div>
                </div>
                <div className="p-2 rounded-lg bg-white/5 border border-white/5">
                   <div className="text-[8px] text-white/40 uppercase font-bold">Temporal Audit</div>
                   <div className="text-[14px] font-mono font-bold text-[#3b82f6]">{healthData.score_components?.temporal_coverage_pct}%</div>
                </div>
             </div>
          </div>
        )}
      </div>
    );
  };

  return (
    <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '16px', height: '100%' }}>
      <HealthGradeBadge />

      {/* Upload Area */}
      <div
        className={`upload-zone ${dragActive ? 'active' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setDragActive(true); }}
        onDragLeave={() => setDragActive(false)}
        onDrop={handleDrop}
        onClick={() => fileInputRef.current?.click()}
        style={{
          border: `2px dashed ${dragActive ? 'var(--primary)' : 'var(--border-color)'}`,
          borderRadius: '12px',
          padding: '24px',
          textAlign: 'center',
          cursor: 'pointer',
          background: dragActive ? 'rgba(168, 139, 250, 0.1)' : 'var(--surface)',
          transition: 'all 0.2s ease'
        }}
      >
        <Upload size={32} style={{ margin: '0 auto 12px', color: 'var(--text-muted)' }} />
        <div style={{ fontSize: '14px', fontWeight: '500' }}>
          {uploading ? 'Uploading...' : 'Drop files or click to upload'}
        </div>
        <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '4px' }}>
          PDF, TXT, MD supported
        </div>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept=".pdf,.txt,.md"
          style={{ display: 'none' }}
          onChange={handleFileSelect}
        />
      </div>
      
      <div style={{ display: 'flex', gap: '8px', width: '100%' }}>
        <button
          className="btn btn-outline"
          onClick={importFromGutenberg}
          disabled={uploading || ingesting}
          style={{ flex: 1, gap: '8px', justifyContent: 'center' }}
        >
          <Book size={16} />
          Gutenberg TXT
        </button>
        <button
          className="btn btn-outline"
          onClick={importFromUrl}
          disabled={uploading || ingesting}
          style={{ flex: 1, gap: '8px', justifyContent: 'center' }}
        >
          <Link size={16} />
          URL Download
        </button>
      </div>

      {/* Source Cards - Split View */}
      <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '16px' }}>
        
        {/* Staged Files (staging) */}
        {stagedFiles.length > 0 && (
          <div>
            <div style={{ fontSize: '12px', fontWeight: '600', color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '8px', paddingLeft: '4px' }}>
              Raw Media (Staging)
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {stagedFiles.map((file: SourceFile) => (
                <div
                  key={`staged-${file.name}`}
                  className="glass-card source-card"
                  style={{
                    padding: '12px',
                    background: 'var(--surface-elevated)',
                    border: '1px solid var(--border-color)',
                    borderRadius: '10px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '12px',
                    cursor: 'pointer'
                  }}
                >
                  <File size={20} style={{ color: '#ef4444' }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: '13px', fontWeight: '500', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {file.name}
                    </div>
                    <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                      <div className="status-tag meta">STAGED</div>
                      <div className="status-tag size">
                        {(file.size / 1024).toFixed(1)} KB
                      </div>
                    </div>
                  </div>

                  <div style={{ display: 'flex', gap: '4px' }}>
                    <button
                      className="btn btn-ghost"
                      onClick={(e) => {
                        e.stopPropagation();
                        downloadFile(file.name, "staging");
                      }}
                      style={{ padding: '6px' }}
                      title="Download"
                    >
                      <Download size={14} />
                    </button>
                    <button
                      className="btn btn-ghost"
                      onClick={(e) => {
                        e.stopPropagation();
                        deleteFile(file.name, "staging");
                      }}
                      style={{ padding: '6px' }}
                      title="Delete"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Workspace Files (data_in) */}
        <div>
          <div style={{ fontSize: '12px', fontWeight: '600', color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '8px', paddingLeft: '4px' }}>
            Workspace Files (data_in)
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {inFiles.length === 0 && (
              <div style={{ textAlign: 'center', padding: '10px', color: 'var(--text-muted)', fontSize: '13px' }}>
                No input files in "{currentWorkspace}"
              </div>
            )}
            
            {inFiles.map((file: SourceFile) => {
              const isIndexed = indexedFiles.includes(file.name);
              const isSelected = selectedDocuments.includes(file.name);
              return (
                <div
                  key={`in-${file.name}`}
                  className="glass-card source-card"
                  style={{
                    padding: '12px',
                    background: activeSources.has(file.name) 
                      ? 'linear-gradient(135deg, rgba(168, 139, 250, 0.2), rgba(139, 92, 246, 0.1))'
                      : 'var(--surface-elevated)',
                    border: activeSources.has(file.name) 
                      ? '1px solid var(--primary)' 
                      : '1px solid var(--border-color)',
                    borderRadius: '10px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '12px',
                    transition: 'all 0.2s ease',
                    cursor: 'pointer'
                  }}
                  onClick={() => {
                    toggleActive(file.name);
                    setActiveDocument({ name: file.name, subdir: 'data_in' });
                  }}
                >
                  <input 
                    type="checkbox" 
                    checked={isSelected}
                    onChange={() => {}}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleSelectedDocument(file.name);
                    }}
                    style={{ cursor: 'pointer', width: '16px', height: '16px', accentColor: 'var(--primary)' }}
                    title="Select document as context for Notebook chat"
                    disabled={!isIndexed}
                  />
                  {getFileIcon(file.name)}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <div style={{ fontSize: '13px', fontWeight: '500', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {file.name}
                      </div>
                      {isIndexed && (
                        <div className="status-tag indexed">
                          <div className="tag-dot" />
                          INDEXED
                        </div>
                      )}
                    </div>
                    <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                      <div className="status-tag meta">
                        {file.name.split('.').pop()?.toUpperCase()}
                      </div>
                      <div className="status-tag size">
                        {(file.size / 1024).toFixed(1)} KB
                      </div>
                    </div>
                  </div>

                  
                  <div style={{ display: 'flex', gap: '4px' }}>
                    <button
                      className="btn btn-ghost"
                      onClick={(e) => {
                        e.stopPropagation();
                        downloadFile(file.name, "data_in");
                      }}
                      style={{ padding: '6px' }}
                      title="Download"
                    >
                      <Download size={14} />
                    </button>
                    <button
                      className="btn btn-ghost"
                      onClick={(e) => {
                        e.stopPropagation();
                        deleteFile(file.name, "data_in");
                      }}
                      style={{ padding: '6px' }}
                      title="Delete"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Generated Files (data_out) */}
        <div>
          <div style={{ fontSize: '12px', fontWeight: '600', color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '8px', paddingLeft: '4px' }}>
            Generated Files (data_out)
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {outFiles.length === 0 && (
              <div style={{ textAlign: 'center', padding: '10px', color: 'var(--text-muted)', fontSize: '13px' }}>
                No generated files yet
              </div>
            )}
            
            {outFiles.map((file: SourceFile) => (
              <div
                key={`out-${file.name}`}
                className="glass-card source-card"
                style={{
                  padding: '12px',
                  background: 'var(--surface-elevated)',
                  border: '1px solid var(--border-color)',
                  borderRadius: '10px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '12px',
                  cursor: 'pointer',
                  transition: 'all 0.2s ease',
                }}
                onClick={() => setActiveDocument({ name: file.name, subdir: 'data_out' })}
              >
                {getFileIcon(file.name)}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: '13px', fontWeight: '500', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {file.name}
                  </div>
                  <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                    {(file.size / 1024).toFixed(1)} KB
                  </div>
                </div>
                
                <div style={{ display: 'flex', gap: '4px' }}>
                  <button
                    className="btn btn-ghost"
                    onClick={() => downloadFile(file.name, "data_out")}
                    style={{ padding: '6px' }}
                    title="Download"
                  >
                    <Download size={14} />
                  </button>
                  <button
                    className="btn btn-ghost"
                    onClick={() => deleteFile(file.name, "data_out")}
                    style={{ padding: '6px' }}
                    title="Delete"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Ingest Button and Logs */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {/* Strategy Control */}
        <div style={{ display: 'flex', gap: '8px' }}>
           <button 
             onClick={() => setIngestionStrategy('safe')}
             className={`flex-1 flex items-center justify-center gap-2 py-3 rounded-xl border transition-all ${ingestionStrategy === 'safe' ? 'bg-[#39FF14]/10 border-[#39FF14]/40 text-[#39FF14]' : 'bg-black/20 border-white/5 text-white/40'}`}
             title="Safe Mode: Exact mapping and validated relationships only."
           >
              <ShieldCheck size={14} />
              <div className="flex flex-col items-start leading-tight">
                 <span className="text-[10px] font-bold">SAFE_MODE</span>
                 <span className="text-[8px] opacity-60">Exact Correlations</span>
              </div>
           </button>
           <button 
             onClick={() => setIngestionStrategy('aggressive')}
             className={`flex-1 flex items-center justify-center gap-2 py-3 rounded-xl border transition-all ${ingestionStrategy === 'aggressive' ? 'bg-[#FF00FF]/10 border-[#FF00FF]/40 text-[#FF00FF]' : 'bg-black/20 border-white/5 text-white/40'}`}
             title="Aggressive: Uses semantic embedding and graph traversal for wider synthesis."
           >
              <Zap size={14} />
              <div className="flex flex-col items-start leading-tight">
                 <span className="text-[10px] font-bold">AGGRESSIVE</span>
                 <span className="text-[8px] opacity-60">Semantic Inference</span>
              </div>
           </button>
        </div>

        {/* Deep Synthesis & Sensitivity Slider */}
        <div style={{ background: 'rgba(255,255,255,0.02)', padding: '12px', borderRadius: '12px', border: '1px solid var(--border-color)', display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
               <div className="flex items-center gap-2">
                  <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: deepSynthesis ? 'var(--primary)' : 'var(--text-muted)' }} />
                  <span className="text-[10px] font-bold text-white/80 uppercase">Deep Synthesis Triple Extraction</span>
               </div>
               <button 
                 onClick={() => setDeepSynthesis(!deepSynthesis)}
                 className={`w-10 h-5 rounded-full transition-all relative ${deepSynthesis ? 'bg-var(--primary)' : 'bg-white/10'}`}
                 style={{ backgroundColor: deepSynthesis ? '#8b5cf6' : 'rgba(255,255,255,0.1)' }}
               >
                  <div className={`absolute top-1 w-3 h-3 bg-white rounded-full transition-all ${deepSynthesis ? 'right-1' : 'left-1'}`} />
               </button>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                   <span className="text-[10px] font-bold text-white/40 uppercase">Correlation Sensitivity</span>
                   <span className="text-[10px] font-mono text-[#FF00FF]">{correlationThreshold.toFixed(2)}</span>
                </div>
                <input 
                  type="range" 
                  min="0.4" max="1.0" step="0.05"
                  value={correlationThreshold}
                  onChange={(e) => setCorrelationThreshold(parseFloat(e.target.value))}
                  style={{ width: '100%', accentColor: '#FF00FF', height: '4px' }}
                />
            </div>

            <button 
              onClick={handleForceCorrelate}
              className="btn btn-outline"
              style={{ padding: '6px 12px', fontSize: '9px', fontWeight: 'bold', width: '100%', border: '1px solid rgba(255,0,255,0.2)', color: '#FF00FF' }}
            >
               <RefreshCw size={10} style={{ marginRight: '6px' }} />
               REFINE MAPPING (Neural Spark)
            </button>
        </div>

        <div style={{ display: 'flex', gap: '8px' }}>
          <button
            className="btn btn-gradient"
            onClick={ingestFiles}
            disabled={activeSources.size === 0 || ingesting}
            style={{ flex: 1, gap: '8px' }}
          >
            {ingesting ? (
              <>
                <Loader className="animate-spin" size={16} />
                Indexing in background...
              </>
            ) : (
              <>
                Index {activeSources.size} file{activeSources.size !== 1 ? 's' : ''}
              </>
            )}
          </button>

          <button
            className="btn btn-outline"
            onClick={() => setShowLogs(!showLogs)}
            style={{ padding: '8px', background: showLogs ? 'var(--surface-elevated)' : 'transparent', flexShrink: 0 }}
            title="Toggle Ingestion Logs"
          >
            <Terminal size={20} />
          </button>
        </div>

        {/* Batch Size Control */}
        <div style={{ 
          background: 'rgba(255,255,255,0.03)', 
          padding: '10px 14px', 
          borderRadius: '8px', 
          display: 'flex', 
          alignItems: 'center', 
          gap: '12px',
          border: '1px solid var(--border-color)'
        }}>
          <div style={{ flex: 1 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
               <label style={{ fontSize: '10px', color: 'var(--text-muted)', fontWeight: 'bold', textTransform: 'uppercase' }}>Ingestion Batch Size</label>
               <span style={{ fontSize: '10px', color: 'var(--primary)', fontWeight: 'bold' }}>{batchSize} chunks</span>
            </div>
            <input 
              type="range" 
              min="100" 
              max="2000" 
              step="100" 
              value={batchSize} 
              onChange={(e) => setBatchSize(parseInt(e.target.value))}
              style={{ width: '100%', accentColor: 'var(--primary)', height: '4px', cursor: 'pointer' }}
            />
          </div>
        </div>


        {(ingesting || showLogs) && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            {activeTasks.map((task) => (
               <IngestionDashboard key={task.task_id} task={task} />
            ))}
            
            {/* Fallback Legacy Logs if no tasks found */}
            {activeTasks.length === 0 && (
              <div style={{
                background: '#1e1e1e',
                color: '#8b5cf6',
                fontFamily: 'monospace',
                fontSize: '11px',
                padding: '12px',
                borderRadius: '8px',
                textAlign: 'center'
              }}>
                Initialising Cognitive Inquisitor...
              </div>
            )}
            <div ref={logsEndRef} />
          </div>
        )}
      </div>
    </div>
  );
}
