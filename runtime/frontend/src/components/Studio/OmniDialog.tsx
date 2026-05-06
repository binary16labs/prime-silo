import { motion, AnimatePresence } from 'framer-motion';
import { X, Cpu, Database, List, Activity } from 'lucide-react';
import { useState } from 'react';

import { useWorkflowStore } from '../../hooks/useWorkflowStore';

export function OmniDialog() {
  const [isExploded, setIsExploded] = useState(false);
  const { selectedNode, nodes, reasoningTraces, executionStatus, setSelectedNode } = useWorkflowStore();

  const node = nodes.find(n => n.id === selectedNode);
  const trace = selectedNode ? reasoningTraces[selectedNode] : null;

  if (!selectedNode || !node) return null;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ x: 400, opacity: 0 }}
        animate={{ x: 0, opacity: 1 }}
        exit={{ x: 400, opacity: 0 }}
        className="absolute right-6 top-32 bottom-32 w-[450px] glass-panel rounded-2xl z-50 flex flex-col overflow-hidden shadow-[0_0_50px_rgba(0,255,255,0.1)]"
      >
        {/* Header */}
        <div className="p-6 border-bottom border-[#00FFFF]/20 flex justify-between items-center bg-[#020408]/40">
          <div className="flex items-center gap-3">
             <div className={`p-2 rounded-lg ${executionStatus[node.id] === 'running' ? 'bg-[#00FFFF]/20' : 'bg-white/5'}`}>
                <Cpu className={`w-5 h-5 ${executionStatus[node.id] === 'running' ? 'glow-text-cyan' : 'text-white/40'}`} />
             </div>
             <div>
               <h2 className="text-[14px] font-bold tracking-widest text-white uppercase">{node.id}</h2>
               <div className="text-[10px] text-[#00FFFF]/60">{executionStatus[node.id]?.toUpperCase() || 'IDLE'}</div>
             </div>
          </div>
          <button 
            onClick={() => setSelectedNode(null)}
            className="p-2 hover:bg-white/10 rounded-full transition-colors"
          >
            <X size={18} className="text-white/40" />
          </button>
        </div>

        {/* Tabs / Content Area */}
        <div className="flex-1 overflow-y-auto custom-scrollbar p-6 space-y-8">
          
          <div className="flex justify-between items-center mb-2">
            <h3 className="text-[10px] font-bold text-[#00FFFF] tracking-[0.2em] flex items-center gap-2">
              <Activity size={12} /> NEURAL_RESOLUTION
            </h3>
            <button 
              onClick={() => setIsExploded(!isExploded)}
              className={`text-[9px] px-2 py-1 rounded border transition-all ${isExploded ? 'bg-[#FF5F1F] text-black border-[#FF5F1F]' : 'text-[#FF5F1F] border-[#FF5F1F]/30 hover:bg-[#FF5F1F]/10'} font-bold`}
            >
              {isExploded ? 'COLLAPSE_SHARDS' : 'EXPLODE_DETAIL'}
            </button>
          </div>

          <AnimatePresence mode="wait">
            {isExploded ? (
              <motion.div 
                key="exploded"
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 1.05 }}
                className="grid grid-cols-3 gap-2"
              >
                {[...Array(12)].map((_, i) => (
                  <div key={i} className="aspect-square glass-panel p-2 flex flex-col justify-between group hover:border-[#FF5F1F]/50 transition-all">
                    <div className="w-1 h-1 rounded-full bg-[#FF5F1F]/40 group-hover:bg-[#FF5F1F]" />
                    <div className="text-[7px] text-white/30 font-mono">SHARD_0x{i.toString(16).toUpperCase()}</div>
                    <div className="h-[2px] w-full bg-[#00FFFF]/10 rounded-full overflow-hidden">
                       <div className="h-full bg-[#00FFFF] w-1/2 animate-pulse" />
                    </div>
                  </div>
                ))}
              </motion.div>
            ) : (
              <motion.div 
                key="standard"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="space-y-8"
              >
                {/* Section: REASONING */}
                <section>
                  <div className="space-y-4">
                    <div className="bg-[#00FFFF]/5 border border-[#00FFFF]/10 rounded-lg p-4">
                      <div className="text-[9px] text-[#00FFFF]/40 uppercase mb-1">INTENT</div>
                      <div className="text-[12px] text-white/90 leading-relaxed">
                        {trace?.intent || "Establishing cognitive path for swarm execution..."}
                      </div>
                    </div>
                    <div className="bg-[#00FFFF]/5 border border-[#00FFFF]/10 rounded-lg p-4">
                      <div className="text-[9px] text-[#00FFFF]/40 uppercase mb-1">INFERENCE</div>
                      <div className="text-[12px] text-white/90 leading-relaxed italic">
                        {trace?.inference || "Awaiting synaptic resonance..."}
                      </div>
                    </div>
                  </div>
                </section>

                {/* Section: SUB-PROCESSES */}
                <section>
                  <h3 className="text-[10px] font-bold text-[#FF5F1F] tracking-[0.2em] mb-4 flex items-center gap-2">
                    <List size={12} /> SUB_PROCESS_STACK
                  </h3>
                  <div className="space-y-2 font-mono text-[10px]">
                    <div className="flex items-center gap-3 text-white/40">
                      <div className="w-1 h-1 rounded-full bg-[#FF5F1F]" />
                      <span>PARSE_INPUT_STREAM</span>
                      <span className="flex-1 border-b border-dashed border-white/10 mx-2" />
                      <span className="text-[#39FF14]">OK</span>
                    </div>
                    <div className="flex items-center gap-3 text-white/40">
                      <div className="w-1 h-1 rounded-full bg-[#FF5F1F]" />
                      <span>RESOLVE_DEPENDENCIES</span>
                      <span className="flex-1 border-b border-dashed border-white/10 mx-2" />
                      <span className="text-[#FF5F1F]">WAIT</span>
                    </div>
                  </div>
                </section>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Footer Actions */}
        <div className="p-4 bg-[#020408]/60 border-top border-[#00FFFF]/10 flex gap-3">
           <button className="flex-1 py-2 rounded-lg border border-[#00FFFF]/30 text-[#00FFFF] text-[10px] font-bold tracking-widest hover:bg-[#00FFFF]/10 transition-all uppercase">
              Download Artifacts
           </button>
           <button className="flex-1 py-2 rounded-lg bg-[#00FFFF]/10 text-white text-[10px] font-bold tracking-widest hover:bg-[#00FFFF]/20 transition-all uppercase">
              Full Lineage
           </button>
        </div>

      </motion.div>
    </AnimatePresence>
  );
}
