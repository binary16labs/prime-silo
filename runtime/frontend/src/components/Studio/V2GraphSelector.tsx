import { useState, useEffect } from 'react';
import { useWorkspaceStore } from '../../hooks/useWorkspaceStore';
import { ChevronDown, Database, Share2, Layers, RefreshCw, Clock } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

export default function V2GraphSelector() {
  const { currentWorkspace, activeGraphId, setActiveGraphId, graphCatalog, fetchGraphCatalog } = useWorkspaceStore();
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    if (currentWorkspace) {
      fetchGraphCatalog();
    }
  }, [currentWorkspace, fetchGraphCatalog]);

  const activeGraph = graphCatalog.find(g => g.id === activeGraphId) || { name: 'NEURAL_NEXUS', type: 'knowledge' };

  const codeSnapshots = graphCatalog.filter(g => g.type === 'code');
  const knowledgeRuns = graphCatalog.filter(g => g.type === 'knowledge' && !g.is_global);
  const globalNexus = graphCatalog.find(g => g.is_global);

  return (
    <div className="fixed top-12 right-64 z-[100] pointer-events-auto">
      <motion.div 
        initial={{ y: -20, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        className="flex items-center gap-1"
      >
        <button 
          onClick={() => setIsOpen(!isOpen)}
          className="flex items-center gap-3 px-6 py-2 rounded-full border border-[#8b5cf6]/40 bg-[#1e1432]/60 backdrop-blur-xl hover:bg-[#8b5cf6]/20 transition-all text-[#a78bfa] font-black text-[11px] tracking-[0.2em] shadow-[0_0_30px_rgba(139,92,246,0.2)] group"
        >
          {activeGraph.type === 'code' ? <Database size={14} className="text-[#34c759]" /> : <Share2 size={14} className="text-[#a78bfa]" />}
          <span className="max-w-[180px] overflow-hidden text-ellipsis whitespace-nowrap uppercase">
            {activeGraph.name}
          </span>
          <ChevronDown size={14} className={`transition-transform duration-300 ${isOpen ? 'rotate-180' : ''}`} />
        </button>

        <button 
          onClick={(e) => { e.stopPropagation(); fetchGraphCatalog(); }}
          className="p-2 rounded-full border border-white/5 bg-white/5 hover:bg-white/10 text-white/40 hover:text-white transition-all shadow-lg"
          title="Refresh Catalog"
        >
          <RefreshCw size={14} />
        </button>
      </motion.div>

      <AnimatePresence>
        {isOpen && (
          <>
            <div className="fixed inset-0 bg-black/20 backdrop-blur-sm z-[-1]" onClick={() => setIsOpen(false)} />
            <motion.div 
              initial={{ opacity: 0, y: 10, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 10, scale: 0.95 }}
              className="absolute top-full left-1/2 -translate-x-1/2 mt-4 w-[340px] glass-panel p-1 border-[#8b5cf6]/20 shadow-[0_20px_50px_rgba(0,0,0,0.8)] bg-[#0c0c14]/95 overflow-hidden rounded-2xl"
            >
              <div className="max-h-[70vh] overflow-y-auto custom-scrollbar p-3 space-y-4">
                
                {/* Global Views */}
                <div>
                  <div className="text-[9px] font-black text-white/30 px-3 py-1 mb-2 tracking-[0.3em] uppercase">Global_Perspectives</div>
                  {globalNexus && (
                    <CatalogItem 
                      item={globalNexus} 
                      isActive={activeGraphId === globalNexus.id} 
                      onClick={() => { setActiveGraphId(globalNexus.id); setIsOpen(false); }}
                    />
                  )}
                </div>

                {/* Code Scans */}
                {codeSnapshots.length > 0 && (
                  <div>
                    <div className="text-[9px] font-black text-[#34c759]/40 px-3 py-1 mb-2 tracking-[0.3em] uppercase">Architectural_Snapshots</div>
                    <div className="space-y-1">
                      {codeSnapshots.map(snap => (
                        <CatalogItem 
                          key={snap.id} 
                          item={snap} 
                          isActive={activeGraphId === snap.id} 
                          onClick={() => { setActiveGraphId(snap.id); setIsOpen(false); }}
                        />
                      ))}
                    </div>
                  </div>
                )}

                {/* Knowledge Runs */}
                {knowledgeRuns.length > 0 && (
                  <div>
                    <div className="text-[9px] font-black text-[#a78bfa]/40 px-3 py-1 mb-2 tracking-[0.3em] uppercase">Synthesis_Records</div>
                    <div className="space-y-1">
                      {knowledgeRuns.map(run => (
                        <CatalogItem 
                          key={run.id} 
                          item={run} 
                          isActive={activeGraphId === run.id} 
                          onClick={() => { setActiveGraphId(run.id); setIsOpen(false); }}
                        />
                      ))}
                    </div>
                  </div>
                )}

                {(codeSnapshots.length === 0 && knowledgeRuns.length === 0) && (
                  <div className="py-10 text-center opacity-30">
                    <Layers size={24} className="mx-auto mb-2" />
                    <div className="text-[10px] font-bold uppercase tracking-widest">No_Snapshots_Found</div>
                  </div>
                )}
              </div>
              
              <div className="px-4 py-3 bg-white/5 text-[9px] text-white/40 flex justify-between items-center border-t border-white/5">
                <span>ACTIVE_WORKSPACE: {currentWorkspace?.toUpperCase()}</span>
                <span className="font-mono">CONTEXT_CONNECTED</span>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}

function CatalogItem({ item, isActive, onClick }: { item: any, isActive: boolean, onClick: () => void }) {
  const isCode = item.type === 'code';
  const color = isCode ? '#34c759' : '#a78bfa';

  return (
    <button
      onClick={onClick}
      className={`w-full group relative flex flex-col gap-1 p-3 rounded-xl transition-all border ${
        isActive 
        ? `bg-${isCode ? '[#163a2a]' : '[#1e1432]'}/40 border-${isCode ? '[#34c759]' : '[#8b5cf6]'}/40` 
        : 'border-transparent hover:bg-white/5 hover:border-white/10'
      }`}
    >
      <div className="flex items-center gap-3">
        <div className={`p-1.5 rounded-lg ${isActive ? 'bg-white/10' : 'bg-white/5'} transition-colors`}>
          {isCode ? <Database size={12} style={{ color }} /> : <Share2 size={12} style={{ color }} />}
        </div>
        <div className="flex-1 text-left min-w-0">
          <div className={`text-[11px] font-bold truncate tracking-wider ${isActive ? 'text-white' : 'text-white/70'}`}>
            {item.name}
          </div>
          <div className="flex items-center gap-2 mt-0.5 text-[9px] text-white/30 font-mono">
            <Clock size={10} />
            <span>{new Date(item.timestamp).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })}</span>
          </div>
        </div>
        {isActive && (
           <div className={`w-1.5 h-1.5 rounded-full shadow-[0_0_10px_${color}]`} style={{ backgroundColor: color }} />
        )}
      </div>
    </button>
  );
}
