import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { 
  Info, 
  FileCode, 
  Link, 
  Hash, 
  MapPin, 
  Zap, 
  ArrowRight,
  Database,
  Search,
  ChevronRight,
  Clock,
  ExternalLink,
  Target,
  Code as CodeIcon,
  X
} from 'lucide-react';
import Editor from '@monaco-editor/react';
import { useWorkspaceStore } from '../../hooks/useWorkspaceStore';
import { API_BASE_URL, GOVERNANCE_HEADERS } from '../../constants';

interface InspectorProps {
  selection: {
    type: 'node' | 'edge';
    data: any;
  } | null;
  onClose: () => void;
}

export function SymbolInspector({ selection, onClose }: InspectorProps) {
  const { currentWorkspace, setFocusPath, setActiveDocument } = useWorkspaceStore();
  const [showCode, setShowCode] = React.useState(false);
  const [codeContent, setCodeContent] = React.useState<string | null>(null);
  const [loadingCode, setLoadingCode] = React.useState(false);

  React.useEffect(() => {
    setShowCode(false);
    setCodeContent(null);
  }, [selection]);

  if (!selection) return null;

  const { type, data } = selection;

  const fetchCode = async () => {
    if (!data.path || showCode) {
      setShowCode(!showCode);
      return;
    }
    
    setLoadingCode(true);
    setShowCode(true);
    try {
      // Logic to resolvesubdir based on path or default to data_in
      const subdir = data.path?.startsWith('data_out/') ? 'data_out' : 'data_in';
      const cleanPath = data.path?.replace('data_in/', '').replace('data_out/', '') || '';
      
      const resp = await fetch(`${API_BASE_URL}/api/files/${currentWorkspace}/${subdir}/${cleanPath}`, {
        headers: { ...GOVERNANCE_HEADERS }
      });
      if (resp.ok) {
        const text = await resp.text();
        setCodeContent(text);
      }
    } catch (e) {
      console.error("Failed to fetch code", e);
    } finally {
      setLoadingCode(false);
    }
  };

  return (
    <motion.div
      initial={{ x: '100%' }}
      animate={{ x: 0 }}
      exit={{ x: '100%' }}
      className={`absolute top-24 bottom-24 right-0 ${showCode ? 'w-[800px]' : 'w-[320px]'} bg-[#020408]/60 backdrop-blur-2xl border-l border-white/10 z-40 flex flex-col shadow-[-20px_0_40px_rgba(0,0,0,0.5)] transition-all duration-500 ease-in-out`}
    >
      {/* Header */}
      <div className="p-6 border-b border-white/5 flex items-center justify-between bg-white/2">
        <div className="flex items-center gap-3">
          <div className={`p-2 rounded-sm ${type === 'node' ? 'bg-[#00FFFF]/10 text-[#00FFFF]' : 'bg-[#FF5F1F]/10 text-[#FF5F1F]'}`}>
            {type === 'node' ? <FileCode size={16} /> : <Link size={16} />}
          </div>
          <div className="flex flex-col">
            <span className="text-[10px] font-black tracking-[0.2em] text-white/40 uppercase">
              {type === 'node' ? 'Symbol_Inspector' : 'Relation_Inspector'}
            </span>
            <span className="text-[12px] font-black text-white tracking-widest truncate max-w-[180px]">
              {data.name || data.type || 'UNKNOWN'}
            </span>
          </div>
        </div>
        <button onClick={onClose} className="p-2 text-white/20 hover:text-white transition-all">
          <ChevronRight size={20} />
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto p-6 space-y-8 custom-scrollbar">
        
        {/* Basic Info */}
        <section className="space-y-4">
           <div className="flex items-center gap-2 text-[9px] font-black text-[#00FFFF] tracking-[0.3em] uppercase">
              <Info size={10} /> Core_Metadata
           </div>
           
           <div className="space-y-3">
              <div className="space-y-1">
                <div className="text-[8px] text-white/20 uppercase tracking-widest font-black">Type</div>
                <div className="text-[10px] text-white/80 font-mono tracking-wider">{data.type || 'N/A'}</div>
              </div>

              {type === 'node' && (
                <div className="space-y-1">
                  <div className="text-[8px] text-white/20 uppercase tracking-widest font-black">Location</div>
                  <div className="text-[10px] text-white/80 font-mono tracking-wider break-all flex items-start gap-2">
                    <MapPin size={10} className="mt-0.5 shrink-0 text-[#00FFFF]/40" />
                    {data.path || 'Unknown Path'}
                  </div>
                </div>
              )}

              {type === 'edge' && (
                <>
                  <div className="space-y-1">
                    <div className="text-[8px] text-white/20 uppercase tracking-widest font-black">Origin</div>
                    <div className="text-[10px] text-white/80 font-mono tracking-wider truncate text-[#00FFFF]">{data.sourceName || data.source}</div>
                  </div>
                  <div className="flex justify-center opacity-20"><ArrowRight size={14} /></div>
                  <div className="space-y-1">
                    <div className="text-[8px] text-white/20 uppercase tracking-widest font-black">Target</div>
                    <div className="text-[10px] text-white/80 font-mono tracking-wider truncate text-[#FF5F1F]">{data.targetName || data.target}</div>
                  </div>
                </>
              )}
           </div>
        </section>

        {/* Dynamic Details */}
        <section className="space-y-4">
           <div className="flex items-center gap-2 text-[9px] font-black text-[#00FFFF] tracking-[0.3em] uppercase">
              <Zap size={10} /> Functional_Context
           </div>
           
           <div className="p-4 bg-white/2 border border-white/5 rounded-sm space-y-3">
              <div className="text-[9px] text-white/40 leading-relaxed uppercase tracking-widest font-mono">
                {type === 'node' 
                   ? `Architectural symbol mapped from cross-stack recursive analysis. Contributes to overall system centrality.`
                   : `Directed UML relationship representing ${data.type} logic between entities.`
                }
              </div>
           </div>
        </section>

        {/* Database Identifiers */}
        <section className="space-y-4">
           <div className="flex items-center gap-2 text-[9px] font-black text-white/20 tracking-[0.3em] uppercase">
              <Database size={10} /> DB_INDEX_P0
           </div>
           <div className="space-y-2">
              <div className="px-3 py-2 bg-[#00FFFF]/5 border border-[#00FFFF]/10 text-[8px] font-mono text-[#00FFFF]/60 break-all leading-tight">
                ID: {data.id || data.elementId || 'NO_INDEX'}
              </div>
           </div>
        </section>

        {/* Code Preview Integration */}
        {showCode && (
           <section className="flex-1 min-h-[400px] flex flex-col space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-[9px] font-black text-[#00FFFF] tracking-[0.3em] uppercase">
                    <CodeIcon size={10} /> Source_Bridge
                </div>
                <button onClick={() => setShowCode(false)} className="text-white/20 hover:text-white transition-all">
                  <X size={12} />
                </button>
              </div>
              <div className="flex-1 rounded border border-white/5 overflow-hidden bg-black/40">
                {loadingCode ? (
                  <div className="h-full flex items-center justify-center">
                    <div className="w-4 h-4 border-2 border-[#00FFFF] border-t-transparent rounded-full animate-spin" />
                  </div>
                ) : (
                  <Editor
                    height="100%"
                    defaultLanguage="python"
                    theme="vs-dark"
                    value={codeContent || "// No source content available"}
                    options={{
                      readOnly: true,
                      minimap: { enabled: false },
                      fontSize: 12,
                      fontFamily: 'JetBrains Mono, monospace',
                      padding: { top: 20 },
                      contextmenu: false
                    }}
                  />
                )}
              </div>
           </section>
        )}

      </div>

      {/* Footer */}
      <div className="p-4 border-t border-white/5 space-y-2">
         {type === 'node' && data.type === 'Concept' && (
           <button 
             onClick={() => {
                const { setWikiHubOpen, setActiveWikiConcept } = (useWorkflowStore.getState() as any);
                setActiveWikiConcept(data.name);
                setWikiHubOpen(true);
             }}
             className="w-full h-10 btn-pill bg-[#FF00FF]/10 border border-[#FF00FF]/40 text-[#FF00FF] hover:bg-[#FF00FF]/20 text-[9px] font-black tracking-[0.2em] flex items-center justify-center gap-2 transition-all shadow-[0_0_15px_rgba(255,0,255,0.1)]"
           >
              <Zap size={12} /> VIEW_RATIONALE_HUB
           </button>
         )}
         {type === 'node' && data.path && (
           <button 
             onClick={fetchCode}
             className={`w-full h-10 btn-pill ${showCode ? 'bg-[#00FFFF] text-black' : 'bg-[#00FFFF]/10 border-[#00FFFF]/40 text-[#00FFFF]'} hover:bg-[#00FFFF]/20 text-[9px] font-black tracking-[0.2em] flex items-center justify-center gap-2 transition-all`}
           >
              <CodeIcon size={12} /> {showCode ? 'HIDE_SOURCE' : 'VIEW_SOURCE_BRIDGE'}
           </button>
         )}
         {type === 'node' && (data.type === 'File' || (data.path && data.path.includes('/'))) && (
           <button 
             onClick={() => setFocusPath(data.path)}
             className="w-full h-10 btn-pill bg-white/5 border border-white/10 text-white/60 hover:text-white text-[9px] font-black tracking-[0.2em] flex items-center justify-center gap-2 transition-all"
           >
              <Target size={12} /> SEMANTIC_FOCUS
           </button>
         )}
      </div>

    </motion.div>
  );
}
