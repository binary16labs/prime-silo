import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Database,
  Activity,
  Trash2,
  History,
  Settings,
  Cpu,
  Layers,
  AlertCircle,
  ShieldCheck,
  Search,
  Zap,
  RefreshCw,
  X,
  Play,
  Square
} from 'lucide-react';
import { useWorkflowStore } from '../../hooks/useWorkflowStore';
import { useWorkspaceStore } from '../../hooks/useWorkspaceStore';
import { useLLMStatus } from '../../hooks/useLLMStatus';
import { DynamicOverlay } from './DynamicOverlay';
import { API_BASE_URL, GOVERNANCE_HEADERS } from '../../constants';

// --- Sub-components pour l'esthétique ---

function StatCard({ label, value, icon: Icon, color }: { label: string, value: string | number, icon: any, color: string }) {
  return (
    <div className="bg-white/5 border border-white/10 p-4 rounded-sm space-y-2">
      <div className="flex justify-between items-center">
        <Icon className={`w-4 h-4 ${color}`} />
        <span className={`text-[9px] font-black tracking-widest uppercase opacity-40`}>{label}</span>
      </div>
      <div className="text-xl font-black text-white tracking-widest">{value}</div>
    </div>
  );
}

// --- Tab: Overview ---

function OverviewTab({ stats, loading }: { stats: any, loading: boolean }) {
  if (loading) return <div className="p-8 text-center animate-pulse text-[#00FFFF]">ACCESSING_NEURAL_CORE...</div>;

  return (
    <div className="grid grid-cols-2 gap-4">
      <StatCard label="Concepts" value={stats.concepts || 0} icon={Cpu} color="text-[#00FFFF]" />
      <StatCard label="Sources" value={stats.sources || 0} icon={Layers} color="text-[#39FF14]" />
      <StatCard label="Triples" value={stats.relationships || 0} icon={Database} color="text-[#ffffff]" />
      <StatCard label="Conflicts" value={stats.conflicts || 0} icon={AlertCircle} color="text-[#FF5F1F]" />
      <StatCard label="Analogies" value={stats.analogies || 0} icon={Zap} color="text-[#FFFF00]" />
      
      <div className="col-span-2 mt-4 p-4 border border-[#00FFFF]/20 bg-[#00FFFF]/5 rounded-sm">
        <h3 className="text-[10px] font-black text-[#00FFFF] tracking-widest mb-2 uppercase flex items-center gap-2">
          <ShieldCheck size={12} /> Optimization_Logic
        </h3>
        <p className="text-[9px] text-[#00FFFF]/60 leading-relaxed uppercase tracking-widest">
          Global centrality is calculated via PageRank approximation. Last optimized: {new Date().toLocaleTimeString()}
        </p>
      </div>
    </div>
  );
}

// --- Tab: Sources ---

function SourcesTab({ sources, onDelete, workspace }: { sources: string[], onDelete: (name: string) => void, workspace: string }) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 p-3 bg-white/5 border border-white/10 rounded-sm mb-4">
        <Search size={14} className="text-[#00FFFF]/40" />
        <input 
          placeholder="SEARCH_KNOWLEDGE_SEGMENTS..." 
          className="bg-transparent border-none outline-none text-[10px] font-mono text-white flex-1 placeholder:text-white/20 uppercase tracking-widest"
        />
      </div>
      <div className="space-y-2 max-h-[300px] overflow-y-auto pr-2 custom-scrollbar">
        {sources.map(src => (
          <div key={src} className="flex items-center justify-between p-3 border border-white/5 bg-white/2 hover:bg-white/5 group transition-all">
            <div className="flex flex-col">
              <span className="text-[10px] font-black text-white tracking-widest uppercase truncate max-w-[200px]">{src}</span>
              <span className="text-[8px] text-white/30 font-mono">SEGMENT_ID: 0x{Math.random().toString(16).slice(2,8).toUpperCase()}</span>
            </div>
            <button 
              onClick={() => onDelete(src)}
              className="p-2 opacity-0 group-hover:opacity-100 hover:text-[#FF5F1F] transition-all"
            >
              <Trash2 size={14} />
            </button>
          </div>
        ))}
        {sources.length === 0 && <div className="text-center py-8 text-white/20 text-[10px] uppercase tracking-widest">No sources mapped.</div>}
      </div>
    </div>
  );
}

// --- Tab: History ---

function HistoryTab({ history, onDelete, workspace }: { history: any[], onDelete: (id: string) => void, workspace: string }) {
  return (
    <div className="space-y-2 max-h-[400px] overflow-y-auto pr-2 custom-scrollbar">
      {history.map(run => (
        <div key={run.run_id} className="p-4 border border-white/5 bg-white/2 hover:bg-white/5 transition-all space-y-3">
          <div className="flex justify-between items-start">
            <div className="space-y-1">
              <div className="text-[10px] font-black text-white tracking-wider uppercase">SYNTHESIS_RUN</div>
              <div className="text-[8px] font-mono text-[#00FFFF]/60">{run.run_id}</div>
            </div>
            <button 
              onClick={() => onDelete(run.run_id)}
              className="text-white/20 hover:text-[#FF5F1F] transition-all"
            >
              <Trash2 size={14} />
            </button>
          </div>
          <div className="grid grid-cols-2 gap-4 text-[8px] font-mono opacity-60 uppercase tracking-widest">
            <div>MODEL: {run.model}</div>
            <div>VER: {run.version}</div>
            <div className="col-span-2 truncate">FILES: {run.files.join(', ')}</div>
            <div className="col-span-2">CREATED: {new Date(run.created_at).toLocaleString()}</div>
          </div>
        </div>
      ))}
      {history.length === 0 && <div className="text-center py-8 text-white/20 text-[10px] uppercase tracking-widest">No synthesis history.</div>}
    </div>
  );
}

// --- Tab: Providers (Utility LLM Management) ---

function ProvidersTab({ providers, loading, activeProvider, setActiveProvider, start, stop }: any) {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-[10px] font-black text-[#00FFFF]/60 tracking-[0.2em] uppercase">NERUAL_RUNNERS</h3>
      </div>
      
      <div className="space-y-3 max-h-[400px] overflow-y-auto pr-2 custom-scrollbar">
        {Object.entries(providers).map(([key, provider]: any) => (
          <div key={key} className={`p-4 border ${activeProvider === key ? 'border-[#00FFFF]/40 bg-[#00FFFF]/5' : 'border-white/5 bg-white/2'} rounded-sm space-y-3`}>
            <div className="flex items-center gap-3">
              <div className={`w-2 h-2 rounded-full ${provider.running ? 'bg-[#39FF14] shadow-[0_0_10px_#39FF14]' : 'bg-white/20'}`} />
              <div className="flex-1">
                <div className="text-[10px] font-black text-white tracking-wider uppercase">{provider.name}</div>
                <div className="text-[8px] font-mono text-white/40">PORT_{provider.port}</div>
              </div>
              {activeProvider === key && <span className="text-[8px] font-black text-[#00FFFF] border border-[#00FFFF]/40 px-1.5 py-0.5 rounded-xs">ACTIVE_KERN</span>}
            </div>

            <div className="flex gap-2">
              <button 
                onClick={() => setActiveProvider(key)}
                className={`flex-1 h-8 text-[9px] font-black tracking-widest uppercase transition-all border ${activeProvider === key ? 'bg-[#00FFFF] text-black border-[#00FFFF]' : 'border-white/10 text-white/40 hover:text-white/60'}`}
              >
                {activeProvider === key ? 'ACTIVE' : 'SELECT'}
              </button>
              {!provider.running ? (
                <button 
                  disabled={!provider.can_start}
                  onClick={() => start(key)}
                  className="px-3 h-8 border border-white/10 text-white/40 hover:text-[#39FF14] hover:border-[#39FF14] transition-all disabled:opacity-30"
                >
                  <Play size={12} />
                </button>
              ) : (
                <button 
                  disabled={!provider.can_stop}
                  onClick={() => stop(key)}
                  className="px-3 h-8 border border-white/10 text-white/40 hover:text-[#FF5F1F] hover:border-[#FF5F1F] transition-all disabled:opacity-30"
                >
                  <Square size={12} />
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// --- Main Manager Component ---

export function GraphManager({ onClose }: { onClose: () => void }) {
  const { currentWorkspace } = useWorkspaceStore();
  const { activeLLMProvider, setActiveLLMProvider } = useWorkspaceStore() as any;
  const { providers, loading: providersLoading, refresh: refreshProviders, startProvider, stopProvider } = useLLMStatus(15000);
  
  const [activeTab, setActiveTab] = useState<'overview' | 'sources' | 'history' | 'providers'>('overview');
  const [stats, setStats] = useState<any>({});
  const [sources, setSources] = useState<string[]>([]);
  const [history, setHistory] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [isOptimizing, setIsOptimizing] = useState(false);

  useEffect(() => {
    refreshData();
  }, [currentWorkspace]);

  const refreshData = async () => {
    setLoading(true);
    try {
      const [statsRes, sourcesRes, historyRes] = await Promise.all([
        fetch(`${API_BASE_URL}/api/graph/stats?workspace=${currentWorkspace}`, { headers: GOVERNANCE_HEADERS }),
        fetch(`${API_BASE_URL}/api/graph/sources?workspace=${currentWorkspace}`, { headers: GOVERNANCE_HEADERS }),
        fetch(`${API_BASE_URL}/api/graph/history?workspace=${currentWorkspace}`, { headers: GOVERNANCE_HEADERS })
      ]);

      if (statsRes.ok) setStats(await statsRes.json());
      if (sourcesRes.ok) {
        const data = await sourcesRes.json();
        setSources(data.sources || []);
      }
      if (historyRes.ok) {
        const data = await historyRes.json();
        setHistory(data.history || []);
      }
    } catch (e) {
      console.error("Failed to refresh graph data", e);
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteSource = async (name: string) => {
    if (!confirm(`Confirm de-segmentation of ${name}? All derived knowledge will be purged.`)) return;
    try {
      const resp = await fetch(`${API_BASE_URL}/api/graph/sources/${name}?workspace=${currentWorkspace}`, {
        method: 'DELETE',
        headers: GOVERNANCE_HEADERS
      });
      if (resp.ok) refreshData();
    } catch (e) {
      console.error("Delete source failed", e);
    }
  };

  const handleDeleteRun = async (runId: string) => {
    if (!confirm(`Purge synthesis run ${runId}?`)) return;
    try {
      const resp = await fetch(`${API_BASE_URL}/api/graph/runs/${runId}?workspace=${currentWorkspace}`, {
        method: 'DELETE',
        headers: GOVERNANCE_HEADERS
      });
      if (resp.ok) refreshData();
    } catch (e) {
      console.error("Delete run failed", e);
    }
  };

  const handleOptimize = async () => {
    setIsOptimizing(true);
    try {
      // Assuming a /api/graph/optimize endpoint exists or using centrality update
      await fetch(`${API_BASE_URL}/api/graph/centrality?workspace=${currentWorkspace}`, {
        method: 'POST',
        headers: GOVERNANCE_HEADERS
      });
      setTimeout(() => {
        setIsOptimizing(false);
        refreshData();
      }, 2000);
    } catch (e) {
      console.error("Optimization failed", e);
      setIsOptimizing(false);
    }
  };

  return (
    <DynamicOverlay 
      title="NEURAL_GRAPH_MANAGER_G3" 
      defaultPosition={{ x: (typeof window !== 'undefined' ? window.innerWidth : 1200) / 2 - 300, y: 150 }}
      defaultSize={{ width: 600, height: 700 }}
      onClose={onClose}
    >
      <div className="h-full flex flex-col bg-[#020408]/40 overflow-hidden font-mono">
        
        {/* Header / Tabs */}
        <div className="flex border-b border-white/10">
          <button 
            onClick={() => setActiveTab('overview')}
            className={`flex-1 p-4 text-[10px] font-black tracking-widest uppercase transition-all ${activeTab === 'overview' ? 'bg-[#00FFFF]/10 text-[#00FFFF]' : 'text-white/40 hover:text-white/60'}`}
          >
            OVERVIEW
          </button>
          <button 
            onClick={() => setActiveTab('sources')}
            className={`flex-1 p-4 text-[10px] font-black tracking-widest uppercase transition-all ${activeTab === 'sources' ? 'bg-[#00FFFF]/10 text-[#00FFFF]' : 'text-white/40 hover:text-white/60'}`}
          >
            SEGMENTS
          </button>
          <button 
            onClick={() => setActiveTab('history')}
            className={`flex-1 p-4 text-[10px] font-black tracking-widest uppercase transition-all ${activeTab === 'history' ? 'bg-[#00FFFF]/10 text-[#00FFFF]' : 'text-white/40 hover:text-white/60'}`}
          >
            AUDIT_LOGS
          </button>
          <button 
            onClick={() => setActiveTab('providers')}
            className={`flex-1 p-4 text-[10px] font-black tracking-widest uppercase transition-all ${activeTab === 'providers' ? 'bg-[#00FFFF]/10 text-[#00FFFF]' : 'text-white/40 hover:text-white/60'}`}
          >
            PROVIDERS
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 p-6 overflow-y-auto">
          {activeTab === 'overview' && <OverviewTab stats={stats} loading={loading} />}
          {activeTab === 'sources' && <SourcesTab sources={sources} onDelete={handleDeleteSource} workspace={currentWorkspace} />}
          {activeTab === 'history' && <HistoryTab history={history} onDelete={handleDeleteRun} workspace={currentWorkspace} />}
          {activeTab === 'providers' && (
            <ProvidersTab 
              providers={providers} 
              loading={providersLoading} 
              activeProvider={activeLLMProvider}
              setActiveProvider={setActiveLLMProvider}
              start={startProvider}
              stop={stopProvider}
            />
          )}
        </div>

        {/* Footer Actions */}
        <div className="p-4 border-t border-white/10 flex gap-4 bg-white/2">
           <button 
             onClick={handleOptimize}
             disabled={isOptimizing || loading}
             className="flex-1 btn-pill h-10 flex items-center justify-center gap-2 border-[#00FFFF]/40 text-[#00FFFF]/80 hover:border-[#00FFFF] hover:text-[#00FFFF] transition-all disabled:opacity-50"
           >
             <Zap size={14} className={isOptimizing ? "animate-pulse" : ""} />
             <span className="text-[9px] font-black tracking-[0.2em]">{isOptimizing ? 'CALCULATING_CENTRALITY...' : 'OPTIMIZE_NEURAL_WEIGHTS'}</span>
           </button>
           <button 
             onClick={refreshData}
             className="w-12 btn-pill h-10 flex items-center justify-center border-white/20 text-white/40 hover:border-white/60 hover:text-white transition-all"
           >
             <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
           </button>
        </div>

      </div>
    </DynamicOverlay>
  );
}
