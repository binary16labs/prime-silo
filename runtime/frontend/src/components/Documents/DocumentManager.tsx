import React, { useState, useEffect, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { 
  Search, Filter, File, FileText, Code, Shield, 
  CheckCircle2, AlertCircle, Clock, MoreHorizontal,
  ExternalLink, Download, Trash2, Eye, RefreshCw
} from 'lucide-react';
import { useWorkspaceStore } from '../../hooks/useWorkspaceStore';
import { API_BASE_URL, GOVERNANCE_HEADERS } from '../../constants';
import UnifiedAssetEditor from './UnifiedAssetEditor';

interface ManifestFile {
  name: string;
  path: string;
  status: 'ALIGNED' | 'STALE' | 'MISSING';
  chunks: number;
  size: number;
  modified: number;
  type: string;
}

export default function DocumentManager() {
  const { currentWorkspace } = useWorkspaceStore();
  const [manifest, setManifest] = useState<ManifestFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterType, setFilterType] = useState('all');
  const [filterStatus, setFilterStatus] = useState('all');
  const [selectedAsset, setSelectedAsset] = useState<ManifestFile | null>(null);

  useEffect(() => {
    fetchManifest();
  }, [currentWorkspace]);

  const fetchManifest = async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE_URL}/api/rag/indexing-manifest?workspace=${currentWorkspace}`, {
        headers: { ...GOVERNANCE_HEADERS }
      });
      const data = await res.json();
      setManifest(data.manifest || []);
    } catch (err) {
      console.error("Failed to fetch manifest:", err);
    } finally {
      setLoading(false);
    }
  };

  const filteredManifest = useMemo(() => {
    return manifest.filter(file => {
      const matchesSearch = file.name.toLowerCase().includes(searchQuery.toLowerCase()) || 
                           file.path.toLowerCase().includes(searchQuery.toLowerCase());
      const matchesType = filterType === 'all' || 
                         (filterType === 'pdf' && file.type === 'pdf') ||
                         (filterType === 'code' && ['py', 'ts', 'js', 'json', 'sql'].includes(file.type)) ||
                         (filterType === 'rules' && file.name.endsWith('.md'));
      const matchesStatus = filterStatus === 'all' || file.status === filterStatus;
      
      return matchesSearch && matchesType && matchesStatus;
    });
  }, [manifest, searchQuery, filterType, filterStatus]);

  const getFileIcon = (file: ManifestFile) => {
    if (file.name.endsWith('.md')) return <Shield size={20} className="text-synaptic-purple" />;
    if (['py', 'ts', 'js', 'json', 'sql'].includes(file.type)) return <Code size={20} className="text-electric-cyan" />;
    if (file.type === 'pdf') return <FileText size={20} className="text-phosphor-orange" />;
    return <File size={20} className="text-text-muted" />;
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'ALIGNED': 
        return <div className="flex items-center gap-1 text-[10px] font-bold text-bios-green opacity-80 bg-bios-green/10 px-2 py-0.5 rounded-full border border-bios-green/30">
          <CheckCircle2 size={10} /> INDEXED
        </div>;
      case 'MISSING':
        return <div className="flex items-center gap-1 text-[10px] font-bold text-phosphor-orange opacity-80 bg-phosphor-orange/10 px-2 py-0.5 rounded-full border border-phosphor-orange/30">
          <Clock size={10} /> UNINDEXED
        </div>;
      case 'STALE':
        return <div className="flex items-center gap-1 text-[10px] font-bold text-synaptic-purple opacity-80 bg-synaptic-purple/10 px-2 py-0.5 rounded-full border border-synaptic-purple/30">
          <AlertCircle size={10} /> STALE
        </div>;
      default: return null;
    }
  };

  return (
    <div className="document-manager-layout w-full h-full flex flex-col p-8 gap-8 overflow-hidden bg-obsidian/40 backdrop-blur-xl">
      {/* Header & Smart Filters */}
      <div className="flex flex-col gap-6">
        <div className="flex justify-between items-end">
          <div>
            <h1 className="text-3xl font-bold bg-gradient-to-r from-white to-white/40 bg-clip-text text-transparent">Smart Asset Gallery</h1>
            <p className="text-text-secondary text-sm mt-2">Manage workspace grounding, governance rules, and cognitive artifacts.</p>
          </div>
          <button 
            onClick={fetchManifest}
            className="flex items-center gap-2 px-4 py-2 bg-white/5 hover:bg-white/10 rounded-lg border border-white/10 text-xs font-bold transition-all"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> REFRESH SCAN
          </button>
        </div>

        <div className="flex gap-4 items-center bg-white/5 p-4 rounded-2xl border border-white/10 backdrop-blur-md">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" size={18} />
            <input 
              type="text" 
              placeholder="Filter assets by name, path or type..."
              className="w-full bg-obsidian/40 border border-white/10 rounded-xl py-2.5 pl-10 pr-4 text-sm focus:outline-none focus:border-synaptic-purple/50 transition-all"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>
          
          <div className="h-8 w-[1px] bg-white/10 mx-2" />

          <div className="flex gap-2">
            {['all', 'pdf', 'code', 'rules'].map(t => (
              <button
                key={t}
                onClick={() => setFilterType(t)}
                className={`px-3 py-1.5 rounded-lg text-[10px] font-bold uppercase transition-all border ${
                  filterType === t ? 'bg-synaptic-purple text-white border-synaptic-purple shadow-[0_0_15px_rgba(192,132,252,0.4)]' : 'bg-white/5 text-text-muted border-white/10 hover:bg-white/10'
                }`}
              >
                {t}
              </button>
            ))}
          </div>

          <div className="h-8 w-[1px] bg-white/10 mx-2" />

          <div className="flex gap-2">
            {['all', 'ALIGNED', 'MISSING'].map(s => (
              <button
                key={s}
                onClick={() => setFilterStatus(s)}
                className={`px-3 py-1.5 rounded-lg text-[10px] font-bold uppercase transition-all border ${
                  filterStatus === s ? 'bg-electric-cyan/20 text-electric-cyan border-electric-cyan/40' : 'bg-white/5 text-text-muted border-white/10 hover:bg-white/10'
                }`}
              >
                {s === 'all' ? 'Any Status' : s === 'ALIGNED' ? 'Indexed' : 'Pending'}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Gallery Grid */}
      <div className="flex-1 overflow-y-auto pr-2 custom-scrollbar">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 pb-8">
          <AnimatePresence>
            {filteredManifest.map((file, idx) => (
              <motion.div
                key={file.path}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.95 }}
                transition={{ duration: 0.4, delay: idx * 0.03 }}
                layout
                onClick={() => setSelectedAsset(file)}
                className="group relative glass-card bg-white/[0.03] hover:bg-white/[0.08] border border-white/10 hover:border-synaptic-purple/40 rounded-2xl p-5 cursor-pointer transition-all duration-300"
              >
                <div className="flex justify-between items-start mb-4">
                  <div className="p-2.5 bg-white/5 rounded-xl group-hover:bg-synaptic-purple/10 transition-colors">
                    {getFileIcon(file)}
                  </div>
                  <div className="flex gap-1">
                    {getStatusBadge(file.status)}
                  </div>
                </div>

                <div className="mb-4">
                  <h3 className="text-sm font-semibold truncate group-hover:text-synaptic-purple transition-colors mb-1" title={file.name}>
                    {file.name}
                  </h3>
                  <p className="text-[10px] text-text-muted font-mono truncate">
                    {file.path || '/'}
                  </p>
                </div>

                <div className="flex items-end justify-between">
                  <div className="flex flex-col gap-1">
                    <span className="text-[9px] text-text-muted font-bold uppercase tracking-wider">Metrics</span>
                    <div className="flex gap-2 text-[10px] text-text-secondary">
                      <span>{(file.size / 1024).toFixed(1)} KB</span>
                      {file.chunks > 0 && <span>• {file.chunks} Chunks</span>}
                    </div>
                  </div>
                  
                  <div className="flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                     <button className="p-1.5 bg-white/5 rounded-lg hover:bg-white/10 text-white/40 hover:text-white transition-all">
                       <ExternalLink size={14} />
                     </button>
                  </div>
                </div>

                {/* Status pulse for non-aligned */}
                {file.status !== 'ALIGNED' && (
                  <div className={`absolute top-2 right-2 w-1.5 h-1.5 rounded-full ${file.status === 'MISSING' ? 'bg-phosphor-orange' : 'bg-synaptic-purple'} animate-pulse`} />
                )}
              </motion.div>
            ))}
          </AnimatePresence>
        </div>

        {filteredManifest.length === 0 && !loading && (
          <div className="flex flex-col items-center justify-center h-64 text-text-muted gap-4">
            <div className="p-6 bg-white/5 rounded-full border border-white/10">
              <Search size={40} className="opacity-20" />
            </div>
            <p className="text-sm">No assets found matching your current filters.</p>
          </div>
        )}
      </div>

      {/* Asset Editor Popout */}
      <AnimatePresence>
        {selectedAsset && (
          <UnifiedAssetEditor 
            asset={selectedAsset} 
            onClose={() => setSelectedAsset(null)} 
          />
        )}
      </AnimatePresence>
    </div>
  );
}
