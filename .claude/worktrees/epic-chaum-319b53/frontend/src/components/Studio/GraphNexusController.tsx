import { useState } from 'react';
import { useWorkflowStore } from '../../hooks/useWorkflowStore';
import { useWorkspaceStore } from '../../hooks/useWorkspaceStore';
import { 
  Database, Share2, Layers, RefreshCw, Clock, Cpu, Activity, 
  Filter, ChevronDown, ChevronRight, Zap, Target, Info, Wind,
  GitFork, Link
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { DynamicOverlay } from './DynamicOverlay';
import { TemporalAudit } from './TemporalAudit';

export function GraphNexusController() {
  const {
    selectionTier, setSelectionTier,
    synthesisMode, setSynthesisMode,
    syncMode, setSyncMode,
    visibleTypes, setVisibleTypes,
    visibleEdgeTypes, setVisibleEdgeTypes,
    showClusters, toggleShowClusters,
    graphRenderSettings, setStarCount, setEnableNodeRotation, setFpsCap, setEnableFreeRotation,
    viewMode,
    cognitiveMesh, toggleCognitiveMesh, setCognitiveMeshValue,
  } = useWorkflowStore();

  const {
    activeGraphId, setActiveGraphId,
    graphCatalog, fetchGraphCatalog
  } = useWorkspaceStore() as any;

  const [isSelectorOpen, setIsSelectorOpen] = useState(false);
  const [isTemporalOpen, setIsTemporalOpen] = useState(false);

  // Selector logic
  const activeGraph = graphCatalog.find((g: any) => g.id === activeGraphId) || { name: 'NEURAL_NEXUS', type: 'knowledge' };
  const codeSnapshots = graphCatalog.filter((g: any) => g.type === 'code');
  const knowledgeRuns = graphCatalog.filter((g: any) => g.type === 'knowledge' && !g.is_global);
  const globalNexus = graphCatalog.find((g: any) => g.is_global);

  if (viewMode !== 'graph') return null;

  return (
    <DynamicOverlay 
      title="GRAPH_NEXUS_CONTROLL"
      defaultPosition={{ x: 32, y: 380 }} // Positioned below Diagnostics by default
      defaultSize={{ width: 380, height: 'auto' }}
      className="max-h-[85vh] overflow-visible"
    >
      <div className="flex flex-col h-full bg-[#020408]/40 overflow-hidden custom-scrollbar">
        
        {/* Section 1: Structural Context (Graph Selector) */}
        <div className="p-4 border-b border-[#00FFFF]/10 bg-white/5">
          <div className="text-[9px] font-black text-[#00FFFF]/40 mb-3 tracking-[0.2em] uppercase flex items-center gap-2">
            <Layers size={10} />
            Structural_Context
          </div>
          
          <div className="relative">
            <div className="flex items-center gap-1">
              <button 
                onClick={() => setIsSelectorOpen(!isSelectorOpen)}
                className="flex-1 flex items-center justify-between px-4 py-2.5 rounded-xl border border-[#8b5cf6]/40 bg-[#1e1432]/60 hover:bg-[#8b5cf6]/20 transition-all group shadow-[0_0_20px_rgba(139,92,246,0.1)]"
              >
                <div className="flex items-center gap-3">
                  {activeGraph.type === 'code' ? <Database size={14} className="text-[#34c759]" /> : <Share2 size={14} className="text-[#a78bfa]" />}
                  <span className="text-[10px] font-bold text-[#a78bfa] tracking-wider uppercase truncate max-w-[150px]">
                    {activeGraph.name}
                  </span>
                </div>
                <ChevronDown size={14} className={`text-[#a78bfa]/60 transition-transform ${isSelectorOpen ? 'rotate-180' : ''}`} />
              </button>
              
              <button 
                onClick={fetchGraphCatalog}
                className="p-2.5 rounded-xl border border-white/5 bg-white/5 hover:bg-white/10 text-white/40 hover:text-white transition-all"
                title="Refresh Catalog"
              >
                <RefreshCw size={14} className={isSelectorOpen ? "animate-spin" : ""} />
              </button>
            </div>

            <AnimatePresence>
              {isSelectorOpen && (
                <motion.div 
                  initial={{ opacity: 0, y: 10, scale: 0.95 }}
                  animate={{ opacity: 1, y: 5, scale: 1 }}
                  exit={{ opacity: 0, y: 10, scale: 0.95 }}
                  className="absolute top-full left-0 right-0 z-50 glass-panel p-1 border-[#8b5cf6]/20 shadow-[0_20px_50px_rgba(0,0,0,0.8)] bg-[#0c0c14]/98 rounded-2xl max-h-[300px] overflow-y-auto custom-scrollbar"
                >
                  <div className="p-2 space-y-4">
                    {/* Global Nexus */}
                    {globalNexus && (
                      <CatalogItem 
                        item={globalNexus} 
                        isActive={activeGraphId === globalNexus.id} 
                        onClick={() => { setActiveGraphId(globalNexus.id); setIsSelectorOpen(false); }}
                      />
                    )}
                    
                    {/* Snapshots */}
                    {codeSnapshots.length > 0 && (
                      <div>
                        <div className="text-[8px] font-black text-white/20 px-3 py-1 mb-1 tracking-widest uppercase">Snapshots</div>
                        {codeSnapshots.map((s: any) => (
                          <CatalogItem key={s.id} item={s} isActive={activeGraphId === s.id} onClick={() => { setActiveGraphId(s.id); setIsSelectorOpen(false); }} />
                        ))}
                      </div>
                    )}

                    {/* Knowledge Runs */}
                    {knowledgeRuns.length > 0 && (
                      <div>
                        <div className="text-[8px] font-black text-white/20 px-3 py-1 mb-1 tracking-widest uppercase">Synthesis</div>
                        {knowledgeRuns.map((r: any) => (
                          <CatalogItem key={r.id} item={r} isActive={activeGraphId === r.id} onClick={() => { setActiveGraphId(r.id); setIsSelectorOpen(false); }} />
                        ))}
                      </div>
                    )}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>

        {/* Section 2: Nexus Controls (LoD, Mode, Filter) */}
        <div className="p-5 space-y-6">
          
          {/* LoD Tier Section */}
          <div className="space-y-3">
             <div className="flex justify-between items-center text-[9px] font-black text-[#00FFFF]/40 uppercase tracking-[0.2em]">
                <div className="flex items-center gap-2">
                  <Target size={10} />
                  Resolution_Tier
                </div>
                <span className="text-[#00FFFF]">T{selectionTier}</span>
             </div>
             <div className="grid grid-cols-3 gap-2">
                {[1, 2, 3].map(t => (
                  <button 
                    key={t}
                    onClick={() => setSelectionTier(t as any)}
                    className={`h-9 rounded-xl border transition-all flex items-center justify-center font-mono text-[10px] ${selectionTier === t ? 'bg-[#00FFFF]/20 border-[#00FFFF]/60 text-[#00FFFF] shadow-[0_0_15px_rgba(0,255,255,0.1)]' : 'bg-white/5 border-white/5 text-white/20 hover:text-white/40'}`}
                  >
                    TIER_{t}
                  </button>
                ))}
             </div>
          </div>

          {/* Synthesis Algorithm */}
          <div className="space-y-3">
             <div className="text-[9px] font-black text-[#00FFFF]/40 uppercase tracking-[0.2em] flex items-center gap-2">
                <Cpu size={10} />
                Synthesis_Protocol
             </div>
             <div className="flex flex-col gap-1.5">
                {[
                  { id: 'structural', label: 'STRUCTURAL', icon: <ChevronRight size={12}/>, color: '#00FFFF' },
                  { id: 'architectural', label: 'ARCHITECTURAL', icon: <Layers size={12}/>, color: '#8b5cf6' },
                  { id: 'neural', label: 'NEURAL_NEBULA', icon: <Activity size={12}/>, color: '#FF00FF' }
                ].map(mode => (
                  <button
                    key={mode.id}
                    onClick={() => setSynthesisMode(mode.id as any)}
                    className={`flex items-center justify-between px-4 py-2.5 rounded-xl border transition-all ${synthesisMode === mode.id ? 'bg-white/10 border-white/20 text-white' : 'bg-black/20 border-white/5 text-white/30 opacity-40 hover:opacity-100'}`}
                  >
                     <div className="flex items-center gap-3">
                        <div style={{ color: synthesisMode === mode.id ? mode.color : 'inherit' }}>{mode.icon}</div>
                        <span className="text-[10px] font-bold tracking-widest uppercase">{mode.label}</span>
                     </div>
                     {synthesisMode === mode.id && <div className="w-1.5 h-1.5 rounded-full bg-white shadow-[0_0_10px_white]" />}
                  </button>
                ))}
             </div>
          </div>

          {/* Synchronization Level */}
          <div className="space-y-3">
             <div className="text-[9px] font-black text-[#FF5F1F]/40 uppercase tracking-[0.2em] flex items-center gap-2">
                <Wind size={10} />
                Temporal_Latency
             </div>
             <div className="grid grid-cols-3 gap-2">
                {[
                  { id: 'real_time', label: 'REAL_TIME', icon: <Zap size={10}/> },
                  { id: 'streaming', label: 'FLUID', icon: <Activity size={10}/> },
                  { id: 'stabilized', label: 'STABLE', icon: <Clock size={10}/> }
                ].map(mode => (
                  <button
                    key={mode.id}
                    onClick={() => setSyncMode(mode.id as any)}
                    className={`flex flex-col items-center justify-center gap-2 py-3 rounded-xl border transition-all ${syncMode === mode.id ? 'bg-[#FF5F1F]/20 border-[#FF5F1F]/60 text-[#FF5F1F] shadow-[0_0_15px_rgba(255,95,31,0.1)]' : 'bg-black/20 border-white/5 text-white/20 hover:text-white/40'}`}
                  >
                     {mode.icon}
                     <span className="text-[8px] font-bold tracking-widest">{mode.label}</span>
                  </button>
                ))}
             </div>
          </div>

          {/* Performance Settings */}
          <div className="space-y-3 pt-2 border-t border-white/5">
            <div className="flex justify-between items-center text-[9px] font-black text-[#FF5F1F]/40 uppercase tracking-[0.2em]">
              <div className="flex items-center gap-2">
                <Zap size={10} />
                Performance_Tuning
              </div>
            </div>

            {/* Star Count Slider */}
            <div className="space-y-2">
              <div className="flex justify-between items-center text-[8px] text-white/60">
                <span className="font-mono">Star Density</span>
                <span className="text-[#FF5F1F] font-bold">{graphRenderSettings.starCount}</span>
              </div>
              <input
                type="range"
                min="0"
                max="5000"
                step="100"
                value={graphRenderSettings.starCount}
                onChange={(e) => setStarCount(Number(e.target.value))}
                className="w-full h-1.5 bg-white/10 rounded-full appearance-none cursor-pointer accent-[#FF5F1F]"
              />
              <div className="text-[7px] text-white/30 flex justify-between">
                <span>none</span>
                <span>normal</span>
                <span>max</span>
              </div>
            </div>

            {/* Node Rotation Toggle */}
            <button
              onClick={() => setEnableNodeRotation(!graphRenderSettings.enableNodeRotation)}
              className={`w-full flex items-center justify-between px-4 py-2.5 rounded-xl border transition-all ${
                graphRenderSettings.enableNodeRotation
                  ? 'bg-[#FF5F1F]/20 border-[#FF5F1F]/60 text-[#FF5F1F]'
                  : 'bg-black/20 border-white/5 text-white/40 hover:text-white/60'
              }`}
            >
              <div className="flex items-center gap-2">
                <Activity size={12} />
                <span className="text-[9px] font-bold tracking-widest uppercase">Node_Rotation</span>
              </div>
              <span className="text-[8px] font-mono">{graphRenderSettings.enableNodeRotation ? 'ON' : 'OFF'}</span>
            </button>

            {/* Free Rotation Toggle */}
            <button
              onClick={() => setEnableFreeRotation(!graphRenderSettings.enableFreeRotation)}
              className={`w-full flex items-center justify-between px-4 py-2.5 rounded-xl border transition-all ${
                graphRenderSettings.enableFreeRotation
                  ? 'bg-[#FF5F1F]/20 border-[#FF5F1F]/60 text-[#FF5F1F]'
                  : 'bg-black/20 border-white/5 text-white/40 hover:text-white/60'
              }`}
            >
              <div className="flex items-center gap-2">
                <Wind size={12} />
                <span className="text-[9px] font-bold tracking-widest uppercase">Free_Rotation</span>
              </div>
              <span className="text-[8px] font-mono">{graphRenderSettings.enableFreeRotation ? 'ON' : 'OFF'}</span>
            </button>

            {/* FPS Cap Slider */}
            <div className="space-y-2">
              <div className="flex justify-between items-center text-[8px] text-white/60">
                <span className="font-mono">Frame Rate Cap</span>
                <span className="text-[#FF5F1F] font-bold">{graphRenderSettings.fpsCap} FPS</span>
              </div>
              <input
                type="range"
                min="15"
                max="120"
                step="15"
                value={graphRenderSettings.fpsCap}
                onChange={(e) => setFpsCap(Number(e.target.value))}
                className="w-full h-1.5 bg-white/10 rounded-full appearance-none cursor-pointer accent-[#FF5F1F]"
              />
              <div className="text-[7px] text-white/30 flex justify-between">
                <span>low</span>
                <span>normal</span>
                <span>max</span>
              </div>
            </div>
          </div>

          {/* Type Filters */}
          <div className="space-y-3">
            <div className="flex justify-between items-center text-[9px] font-black text-[#00FFFF]/40 uppercase tracking-[0.2em]">
               <div className="flex items-center gap-2">
                 <Filter size={10} />
                 Entity_Filters
               </div>
               <button onClick={toggleShowClusters} className={`text-[8px] px-2 py-0.5 rounded border transition-colors ${showClusters ? 'bg-[#FF00FF]/20 border-[#FF00FF]/40 text-[#FF00FF]' : 'border-white/10 text-white/20'}`}>
                 CLUSTERS_{showClusters ? 'ON' : 'OFF'}
               </button>
            </div>
            <div className="flex flex-wrap gap-1.5">
               {['Folder', 'File', 'Class', 'Interface', 'Function', 'Documentation', 'Concept'].map(type => {
                 const isActive = visibleTypes.includes(type);
                 return (
                   <button
                     key={type}
                     onClick={() => setVisibleTypes(isActive ? visibleTypes.filter(t => t !== type) : [...visibleTypes, type])}
                     className={`text-[8px] font-bold px-2.5 py-1.5 rounded-lg border transition-all uppercase tracking-tighter ${isActive ? 'bg-white/10 border-white/30 text-white' : 'bg-black/20 border-white/5 text-white/20 opacity-40'}`}
                   >
                     {type}
                   </button>
                 );
               })}
            </div>
          </div>

          {/* Relationship Audit (UML Smart Filters) */}
          <div className="space-y-3 pt-2 border-t border-white/5">
             <div className="text-[9px] font-black text-[#00FFFF]/40 uppercase tracking-[0.2em] flex items-center gap-2">
                <Share2 size={10} />
                Relationship_Audit
             </div>
             <div className="flex flex-col gap-1.5">
                {[
                  { label: 'Structural', types: ['DEFINES', 'CONTAINS'], icon: <GitFork size={10}/> },
                  { label: 'Lineage', types: ['INHERITS'], icon: <Share2 size={10}/> },
                  { label: 'Dependency', types: ['DEPENDS_ON'], icon: <Link size={10}/> },
                  { label: 'Flow', types: ['CALLS'], icon: <Zap size={10}/> },
                  { label: 'Semantic', types: ['REL'], icon: <Database size={10}/> }
                ].map(cat => {
                  const isActive = cat.types.every(t => visibleEdgeTypes.includes(t));
                  return (
                    <button
                      key={cat.label}
                      onClick={() => {
                        if (isActive) {
                           setVisibleEdgeTypes(visibleEdgeTypes.filter(t => !cat.types.includes(t)));
                        } else {
                           setVisibleEdgeTypes([...new Set([...visibleEdgeTypes, ...cat.types])]);
                        }
                      }}
                      className={`flex items-center justify-between px-3 py-2 rounded-xl border transition-all ${isActive ? 'bg-white/10 border-white/20 text-white' : 'bg-black/20 border-white/5 text-white/10'}`}
                    >
                       <div className="flex items-center gap-2">
                          <div className={isActive ? 'text-[#00FFFF]' : 'text-white/20'}>{cat.icon}</div>
                          <span className="text-[9px] font-black tracking-widest uppercase">{cat.label}</span>
                       </div>
                       <div className={`w-1 h-1 rounded-full ${isActive ? 'bg-[#00FFFF] shadow-[0_0_8px_#00FFFF]' : 'bg-white/10'}`} />
                    </button>
                  );
                })}
             </div>
          </div>
        </div>

        {/* Section 2b: Cognitive Mesh */}
        <div className="px-5 pb-5 space-y-3 border-t border-[#FF00FF]/10 bg-[#FF00FF]/[0.02]">
          <div className="pt-5 text-[9px] font-black text-[#FF00FF]/60 uppercase tracking-[0.2em] flex items-center gap-2">
            <Activity size={10} />
            Cognitive_Mesh
            <span className="ml-auto text-[7px] text-white/30 font-mono">v2.1</span>
          </div>

          <div className="grid grid-cols-2 gap-1.5">
            {([
              ['semanticZoom', 'Semantic Zoom'],
              ['degreeSizing', 'Degree Sizing'],
              ['myelination', 'Myelination'],
              ['synapticPruning', 'Pruning'],
              ['blastRadius', 'Blast Radius'],
              ['dataFlowParticles', 'Flow Particles'],
              ['cycleDetection', 'Cycle Detect'],
              ['neuralNebula', 'Nebula'],
              ['clusterRotation', 'Cluster Rotate'],
              ['agentOrbit', 'Agent Orbit'],
              ['agenticPanels', 'A2UI Panels'],
              ['foveatedLOD', 'Foveated LOD'],
              ['sonification', 'Sonification'],
              ['ambientHeartbeat', 'Heartbeat'],
              ['timeTravelOpen', 'Time Travel'],
            ] as const).map(([key, label]) => {
              const on = cognitiveMesh[key] as boolean;
              return (
                <button
                  key={key}
                  onClick={() => toggleCognitiveMesh(key as any)}
                  className={`px-2 py-1.5 rounded-lg border text-[8px] font-bold tracking-tighter uppercase transition-all ${
                    on
                      ? 'bg-[#FF00FF]/20 border-[#FF00FF]/50 text-[#FF00FF]'
                      : 'bg-black/20 border-white/5 text-white/30 hover:text-white/50'
                  }`}
                >
                  {label}
                </button>
              );
            })}
          </div>

          <div className="space-y-1.5 pt-2">
            <div className="flex justify-between text-[8px] text-white/60 font-mono">
              <span>Prune Threshold</span>
              <span className="text-[#FF00FF]">{cognitiveMesh.pruneThreshold.toFixed(2)}</span>
            </div>
            <input
              type="range" min={0} max={1} step={0.05}
              value={cognitiveMesh.pruneThreshold}
              onChange={e => setCognitiveMeshValue('pruneThreshold', Number(e.target.value))}
              className="w-full h-1.5 bg-white/10 rounded-full appearance-none cursor-pointer accent-[#FF00FF]"
            />
          </div>

          <div className="space-y-1.5">
            <div className="flex justify-between text-[8px] text-white/60 font-mono">
              <span>Particle Density</span>
              <span className="text-[#FF00FF]">{cognitiveMesh.particleDensity.toFixed(1)}</span>
            </div>
            <input
              type="range" min={0} max={3} step={0.1}
              value={cognitiveMesh.particleDensity}
              onChange={e => setCognitiveMeshValue('particleDensity', Number(e.target.value))}
              className="w-full h-1.5 bg-white/10 rounded-full appearance-none cursor-pointer accent-[#FF00FF]"
            />
          </div>

          <div className="space-y-1.5">
            <div className="flex justify-between text-[8px] text-white/60 font-mono">
              <span>Bloom Intensity</span>
              <span className="text-[#FF00FF]">{cognitiveMesh.bloomIntensity.toFixed(1)}</span>
            </div>
            <input
              type="range" min={0} max={2} step={0.1}
              value={cognitiveMesh.bloomIntensity}
              onChange={e => setCognitiveMeshValue('bloomIntensity', Number(e.target.value))}
              className="w-full h-1.5 bg-white/10 rounded-full appearance-none cursor-pointer accent-[#FF00FF]"
            />
          </div>
        </div>

        {/* Section 3: Temporal Sync (Collapsible) */}
        <div className="border-t border-[#00FFFF]/10">
          <button 
            onClick={() => setIsTemporalOpen(!isTemporalOpen)}
            className="w-full flex items-center justify-between px-5 py-4 hover:bg-white/5 transition-colors group"
          >
            <div className="flex items-center gap-3">
              <Clock size={14} className={`transition-colors ${isTemporalOpen ? 'text-[#FF5F1F]' : 'text-[#FF5F1F]/40'}`} />
              <span className={`text-[10px] font-black tracking-[0.2em] uppercase transition-colors ${isTemporalOpen ? 'text-[#FF5F1F]' : 'text-[#FF5F1F]/60'}`}>
                Temporal_Reconstruction
              </span>
            </div>
            <ChevronDown size={14} className={`text-white/20 group-hover:text-white transition-transform ${isTemporalOpen ? 'rotate-180' : ''}`} />
          </button>
          
          <AnimatePresence>
            {isTemporalOpen && (
              <motion.div 
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                className="overflow-hidden bg-[#FF5F1F]/5"
              >
                <div className="p-4 pt-0">
                  <TemporalAudit />
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Footer Info */}
        <div className="px-5 py-3 border-t border-[#00FFFF]/5 bg-black/40 flex justify-between items-center opacity-30">
          <div className="flex items-center gap-2">
             <Info size={10} />
             <span className="text-[8px] font-mono">READY_FOR_SYNTACTIC_REVOLUTION</span>
          </div>
          <span className="text-[8px] font-mono">v2.0.4-NEXUS</span>
        </div>
      </div>
    </DynamicOverlay>
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
        ? `bg-${isCode ? '[#163a2a]' : '[#1e1432]'}/40 border-${isCode ? '[#34c759]' : '[#8b5cf6]'}/40 shadow-[0_0_15px_rgba(0,0,0,0.2)]` 
        : 'border-transparent hover:bg-white/5 hover:border-white/10'
      }`}
    >
      <div className="flex items-center gap-3">
        <div className={`p-1.5 rounded-lg ${isActive ? 'bg-white/10' : 'bg-white/5'}`}>
          {isCode ? <Database size={12} style={{ color }} /> : <Share2 size={12} style={{ color }} />}
        </div>
        <div className="flex-1 text-left min-w-0">
          <div className={`text-[10px] font-bold truncate tracking-wider ${isActive ? 'text-white' : 'text-white/70'}`}>
            {item.name}
          </div>
          <div className="flex items-center gap-2 mt-0.5 text-[8px] text-white/30 font-mono">
            <Clock size={8} />
            <span>{new Date(item.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
          </div>
        </div>
        {isActive && (
           <div className="w-1.5 h-1.5 rounded-full shadow-[0_0_10px_white] bg-white" />
        )}
      </div>
    </button>
  );
}
