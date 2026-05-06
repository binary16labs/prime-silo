import React, { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { 
  X, Save, Download, Trash2, Shield, Code, 
  FileText, ExternalLink, Info, Check, AlertCircle, RefreshCw
} from 'lucide-react';
import { API_BASE_URL, GOVERNANCE_HEADERS } from '../../constants';
import { useWorkspaceStore } from '../../hooks/useWorkspaceStore';

interface AssetFile {
  name: string;
  path: string;
  type: string;
  status: string;
}

interface UnifiedAssetEditorProps {
  asset: AssetFile;
  onClose: () => void;
}

export default function UnifiedAssetEditor({ asset, onClose }: UnifiedAssetEditorProps) {
  const { currentWorkspace } = useWorkspaceStore();
  const [content, setContent] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [format, setFormat] = useState<'text' | 'pdf' | 'binary' | 'error'>('text');
  const [metadata, setMetadata] = useState<any>(null);
  const [assetStatus, setAssetStatus] = useState(asset.status);
  const [isIngesting, setIsIngesting] = useState(false);

  useEffect(() => {
    fetchAssetDetails();
  }, [asset, currentWorkspace]);

  const fetchAssetDetails = async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE_URL}/api/files/preview?workspace=${currentWorkspace}&path=${encodeURIComponent(asset.path)}`, {
        headers: { ...GOVERNANCE_HEADERS }
      });
      if (res.ok) {
        const data = await res.json();
        setMetadata(data);
        setFormat(data.format);
        if (data.format === 'text') {
          setContent(data.content);
        }
      }
    } catch (err) {
      console.error("Failed to fetch asset preview:", err);
      setFormat('error');
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      // If it's a governance manual, use the specific governance API
      const isManual = ['SOUL.md', 'USER.md', 'AGENTS.md'].includes(asset.name);
      const url = isManual 
        ? `${API_BASE_URL}/api/governance/manuals/${currentWorkspace}/${asset.name}`
        : `${API_BASE_URL}/api/files/write?workspace=${currentWorkspace}&path=${encodeURIComponent(asset.path)}`;
      
      const res = await fetch(url, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          ...GOVERNANCE_HEADERS 
        },
        body: JSON.stringify({ content })
      });

      if (res.ok) {
        // Show success pulse
      }
    } catch (err) {
      console.error("Save failed:", err);
    } finally {
      setSaving(false);
    }
  };

  const handleIngest = async () => {
    setIsIngesting(true);
    try {
      const res = await fetch(`${API_BASE_URL}/api/rag/ingest`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          ...GOVERNANCE_HEADERS 
        },
        body: JSON.stringify({ 
          workspace: currentWorkspace,
          files: [asset.name] 
        })
      });

      if (res.ok) {
        setAssetStatus('ALIGNED');
      }
    } catch (err) {
      console.error("Ingest failed:", err);
    } finally {
      setIsIngesting(false);
    }
  };

  const renderEditor = () => {
    if (loading) {
      return (
        <div className="flex-1 flex flex-col items-center justify-center gap-4 text-text-muted">
          <div className="w-12 h-12 border-2 border-synaptic-purple/20 border-t-synaptic-purple rounded-full animate-spin" />
          <p className="text-sm font-mono tracking-widest uppercase">Deciphering Asset...</p>
        </div>
      );
    }

    if (format === 'error') {
      return (
        <div className="flex-1 flex flex-col items-center justify-center gap-4 text-phosphor-orange">
          <AlertCircle size={48} className="opacity-50" />
          <p className="text-sm">Failed to load asset preview.</p>
        </div>
      );
    }

    if (format === 'pdf') {
      return (
        <div className="flex-1 bg-obsidian/20 rounded-xl border border-white/5 overflow-hidden relative">
          <iframe 
            src={`${API_BASE_URL}/api/static/${currentWorkspace}/${asset.path}`}
            className="w-full h-full border-none"
            title="PDF Preview"
          />
        </div>
      );
    }

    if (format === 'binary') {
      return (
        <div className="flex-1 flex flex-col items-center justify-center gap-4 text-text-muted">
          <FileText size={64} className="opacity-20" />
          <p className="text-sm">Binary assets cannot be edited directly.</p>
          <button className="btn btn-outline btn-sm">Download Raw</button>
        </div>
      );
    }

    return (
      <div className="flex-1 flex flex-col gap-4 relative">
        <div className="absolute top-4 right-4 z-10 flex gap-2">
           <div className="px-3 py-1 bg-white/5 backdrop-blur-md rounded-full border border-white/10 text-[10px] font-mono text-synaptic-purple">
             {asset.type.toUpperCase()}
           </div>
        </div>
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          className="flex-1 bg-white/[0.02] border border-white/5 rounded-2xl p-6 text-sm font-mono text-text-secondary focus:outline-none focus:border-synaptic-purple/30 resize-none custom-scrollbar leading-relaxed"
          spellCheck={false}
        />
        
        {saving && (
          <div className="absolute inset-x-0 bottom-4 flex justify-center">
             <div className="px-4 py-1.5 bg-synaptic-purple text-white text-[10px] font-bold rounded-full shadow-[0_0_20px_rgba(192,132,252,0.6)] animate-pulse">
               SAVING TO WORKSPACE...
             </div>
          </div>
        )}
      </div>
    );
  };

  return (
    <motion.div
      initial={{ x: '100%' }}
      animate={{ x: 0 }}
      exit={{ x: '100%' }}
      transition={{ type: 'spring', damping: 25, stiffness: 200 }}
      className="fixed inset-y-0 right-0 w-full md:w-[600px] lg:w-[800px] xl:w-[1000px] bg-obsidian/80 backdrop-blur-3xl border-l border-white/10 z-[100] flex flex-col shadow-[-20px_0_50px_rgba(0,0,0,0.5)]"
    >
      {/* Editor Header */}
      <div className="flex items-center justify-between p-6 border-bottom border-white/5 bg-white/5">
        <div className="flex items-center gap-4">
          <div className={`p-2 rounded-lg ${format === 'pdf' ? 'bg-phosphor-orange/10 text-phosphor-orange' : 'bg-synaptic-purple/10 text-synaptic-purple'}`}>
            {format === 'pdf' ? <FileText size={20} /> : asset.name.endsWith('.md') ? <Shield size={20} /> : <Code size={20} />}
          </div>
          <div>
            <h2 className="text-lg font-bold text-white leading-tight">{asset.name}</h2>
            <p className="text-[10px] font-mono text-text-muted mt-1 truncate max-w-[400px]">
              {asset.path}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          {format === 'text' && (
            <button 
              onClick={handleSave}
              disabled={saving}
              className="flex items-center gap-2 px-4 py-2 bg-synaptic-purple hover:bg-synaptic-purple/80 text-white rounded-xl text-xs font-bold transition-all disabled:opacity-50 shadow-[0_0_15px_rgba(192,132,252,0.3)]"
            >
              <Save size={14} /> SAVE CHANGES
            </button>
          )}
          <button 
            onClick={onClose}
            className="p-2.5 bg-white/5 hover:bg-white/10 rounded-xl text-text-muted hover:text-white transition-all border border-white/5"
          >
            <X size={20} />
          </button>
        </div>
      </div>

      {/* Editor Content Area */}
      <div className="flex-1 flex flex-col p-8 gap-6 overflow-hidden">
        {/* Secondary Meta Info */}
        <div className="grid grid-cols-4 gap-4">
          <div className="bg-white/5 rounded-xl p-3 border border-white/5 flex flex-col justify-between">
            <span className="text-[9px] font-bold text-text-muted uppercase tracking-wider block mb-1">Status</span>
            <div className={`flex items-center justify-between`}>
              <div className={`flex items-center gap-1.5 text-xs font-bold ${assetStatus === 'ALIGNED' ? 'text-bios-green' : 'text-phosphor-orange'}`}>
                <div className={`w-1.5 h-1.5 rounded-full ${assetStatus === 'ALIGNED' ? 'bg-bios-green' : 'bg-phosphor-orange'} ${assetStatus !== 'ALIGNED' ? 'animate-pulse' : ''}`} />
                {assetStatus === 'ALIGNED' ? 'GROUNDED' : 'UNINDEXED'}
              </div>
              {assetStatus !== 'ALIGNED' && (
                <button 
                  onClick={handleIngest}
                  disabled={isIngesting}
                  className="px-2 py-0.5 bg-phosphor-orange/10 hover:bg-phosphor-orange/20 text-phosphor-orange rounded text-[9px] font-bold transition-all disabled:opacity-50 flex items-center gap-1 border border-phosphor-orange/30"
                >
                  <RefreshCw size={10} className={isIngesting ? "animate-spin" : ""} />
                  {isIngesting ? 'INGESTING...' : 'INGEST NOW'}
                </button>
              )}
            </div>
          </div>
          <div className="bg-white/5 rounded-xl p-3 border border-white/5">
            <span className="text-[9px] font-bold text-text-muted uppercase tracking-wider block mb-1">Dimension</span>
            <div className="text-xs font-bold text-white">{(metadata?.size / 1024 || 0).toFixed(2)} KB</div>
          </div>
           <div className="bg-white/5 rounded-xl p-3 border border-white/5">
            <span className="text-[9px] font-bold text-text-muted uppercase tracking-wider block mb-1">Type</span>
            <div className="text-xs font-bold text-white uppercase">{asset.type}</div>
          </div>
           <div className="bg-white/5 rounded-xl p-3 border border-white/5">
            <span className="text-[9px] font-bold text-text-muted uppercase tracking-wider block mb-1">Last Sync</span>
            <div className="text-xs font-bold text-white">{new Date(metadata?.modified * 1000).toLocaleDateString()}</div>
          </div>
        </div>

        {renderEditor()}
      </div>

      {/* Actions Footer */}
      <div className="p-6 bg-white/5 border-t border-white/5 flex justify-between items-center">
        <div className="flex gap-4">
          <button className="flex items-center gap-2 text-xs font-bold text-text-muted hover:text-white transition-all">
            <Download size={14} /> EXPORT
          </button>
          <div className="w-[1px] h-4 bg-white/10" />
          <button className="flex items-center gap-2 text-xs font-bold text-text-muted hover:text-white transition-all">
            <Info size={14} /> AUDIT TRAIL
          </button>
        </div>

        <button className="flex items-center gap-2 px-4 py-2 bg-red-500/10 hover:bg-red-500/20 text-red-500 rounded-xl text-xs font-bold transition-all border border-red-500/20">
          <Trash2 size={14} /> PURGE FROM DISK
        </button>
      </div>
    </motion.div>
  );
}
