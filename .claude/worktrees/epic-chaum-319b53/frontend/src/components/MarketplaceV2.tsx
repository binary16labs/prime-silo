import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Search, Star, Download, Cpu, Sliders, Check, Shield, Zap, Terminal, X, Box } from 'lucide-react';

interface Agent {
  id: string;
  name: string;
  author: string;
  rating: number;
  downloads: string;
  description: string;
  tags: string[];
  color: string;
  defaultParams: {
    temperature: number;
    contextLimit: number;
    model: string;
  };
}

const MOCK_AGENTS: Agent[] = [
  {
    id: '1',
    name: 'Senior Rust Architect',
    author: '@ferris_builder',
    rating: 4.9,
    downloads: '12.4k',
    description: 'Specialized in high-performance Rust systems, memory safety, and concurrent architectures. Enforces strict borrow-checker compliance.',
    tags: ['Rust', 'Systems', 'Architecture'],
    color: '#FF5F1F', 
    defaultParams: { temperature: 0.2, contextLimit: 128000, model: 'claude-3-opus' }
  },
  {
    id: '2',
    name: 'React Flow Master',
    author: '@ui_wizard',
    rating: 4.8,
    downloads: '8.2k',
    description: 'Expert in building complex node-based editors, spatial canvases, and interactive DAG visualizations.',
    tags: ['Frontend', 'React Flow', 'UI/UX'],
    color: '#00FFFF',
    defaultParams: { temperature: 0.6, contextLimit: 64000, model: 'gpt-4-turbo' }
  },
  {
    id: '3',
    name: 'Security Auditor',
    author: '@red_team_actual',
    rating: 4.9,
    downloads: '5.1k',
    description: 'Relentless penetration tester agent. Scans ASTs and dependency trees for vulnerabilities, injection flaws, and auth bypasses.',
    tags: ['Security', 'Pentesting', 'Auth'],
    color: '#FF5F1F',
    defaultParams: { temperature: 0.1, contextLimit: 200000, model: 'claude-3-opus' }
  },
  {
    id: '4',
    name: 'Data Pipeline Engineer',
    author: '@etl_guru',
    rating: 4.7,
    downloads: '15.3k',
    description: 'Designs robust ETL pipelines, optimizes complex SQL queries, and manages distributed data processing workflows.',
    tags: ['Python', 'SQL', 'Data'],
    color: '#39FF14',
    defaultParams: { temperature: 0.3, contextLimit: 128000, model: 'gpt-4-turbo' }
  },
  {
    id: '5',
    name: 'ThreeJS Visualizer',
    author: '@webgl_punk',
    rating: 4.6,
    downloads: '3.8k',
    description: 'Generates optimized WebGL shaders, ThreeJS scenes, and React Three Fiber components for spatial computing.',
    tags: ['WebGL', '3D', 'Shaders'],
    color: '#c084fc',
    defaultParams: { temperature: 0.7, contextLimit: 64000, model: 'claude-3-sonnet' }
  }
];

export function MarketplaceV2() {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedAgent, setSelectedAgent] = useState<Agent | null>(null);
  const [isInstalled, setIsInstalled] = useState(false);

  const filteredAgents = MOCK_AGENTS.filter(agent => 
    agent.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    agent.tags.some(tag => tag.toLowerCase().includes(searchQuery.toLowerCase()))
  );

  return (
    <div className="absolute inset-0 pointer-events-auto bg-transparent flex flex-col items-center justify-center p-12 overflow-hidden">
      
      {/* Background Ambience */}
      <div className="absolute inset-0 pointer-events-none bg-[#020408]/40 backdrop-blur-md" />
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[800px] bg-[#00FFFF]/5 rounded-full blur-[120px]" />
      
      {/* Search Header */}
      <motion.div 
        initial={{ y: -50, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        className="relative z-10 w-full max-w-4xl mb-12 flex flex-col items-center"
      >
        <h2 className="text-3xl font-black glow-text-cyan tracking-[0.5em] mb-8 uppercase">FORGE_HUB_G3</h2>
        <div className="relative w-full max-w-2xl">
          <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-[#00FFFF]/50" />
          <input 
            type="text" 
            placeholder="COLLECTOR_QUERY >> Capability, Tag, or Identifier"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full bg-[#020408]/60 border border-[#00FFFF]/30 rounded-sm py-4 pl-14 pr-6 text-sm text-white placeholder:text-[#00FFFF]/30 font-mono tracking-widest focus:outline-none focus:border-[#00FFFF] shadow-[0_0_20px_rgba(0,0,255,0.1)] transition-all"
          />
        </div>
      </motion.div>

      {/* Discovery Grid: Floating Vitreous Panels */}
      <div className="relative z-10 w-full max-w-7xl flex-1 overflow-visible">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8 p-4">
          <AnimatePresence>
            {filteredAgents.map((agent, i) => (
              <motion.div
                key={agent.id}
                layoutId={`agent-${agent.id}`}
                initial={{ opacity: 0, scale: 0.8, y: 20 }}
                animate={{ 
                  opacity: 1, 
                  scale: 1, 
                  y: 0,
                  transition: { delay: i * 0.1 }
                }}
                whileHover={{ 
                  scale: 1.05, 
                  rotateY: 5, 
                  rotateX: -5,
                  translateZ: 20,
                  transition: { duration: 0.2 }
                }}
                onClick={() => setSelectedAgent(agent)}
                className="glass-panel p-6 cursor-pointer relative group border-[#00FFFF]/10 transition-colors hover:border-[#00FFFF]/40"
              >
                <div className="absolute top-4 right-4 text-[#39FF14] flex items-center gap-1 text-[10px] font-bold">
                  <Star size={10} fill="#39FF14" />
                  {agent.rating}
                </div>
                
                <h3 className="text-lg font-bold mb-1 tracking-wider" style={{ color: agent.color }}>
                  {agent.name.toUpperCase()}
                </h3>
                <div className="text-[9px] text-[#00FFFF]/40 font-mono mb-4">{agent.author}</div>
                
                <p className="text-xs text-white/60 line-clamp-2 mb-6 h-8 font-mono">
                  {agent.description}
                </p>

                <div className="flex items-center justify-between">
                  <div className="flex gap-2">
                    {agent.tags.slice(0, 2).map(tag => (
                      <span key={tag} className="px-2 py-1 text-[8px] font-bold rounded bg-[#00FFFF]/5 text-[#00FFFF] border border-[#00FFFF]/20">
                        {tag}
                      </span>
                    ))}
                  </div>
                  <Download className="w-4 h-4 text-[#00FFFF]/30 group-hover:text-[#00FFFF] transition-colors" />
                </div>
                
                {/* Panel Polish: Sub-grid lines */}
                <div className="absolute inset-0 pointer-events-none border border-white/5 opacity-0 group-hover:opacity-100 transition-opacity">
                   <div className="absolute top-1/2 left-0 right-0 h-[1px] bg-white/5" />
                   <div className="absolute left-1/2 top-0 bottom-0 w-[1px] bg-white/5" />
                </div>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      </div>

      {/* The Forge: Agent Crystallization Overlay */}
      <AnimatePresence>
        {selectedAgent && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[100] flex items-center justify-center p-12 pointer-events-auto"
          >
            <div className="absolute inset-0 bg-[#020408]/90 backdrop-blur-xl" onClick={() => setSelectedAgent(null)} />
            
            <motion.div 
              layoutId={`agent-${selectedAgent.id}`}
              className="glass-panel w-full max-w-4xl h-[600px] relative z-10 flex overflow-hidden border-[#00FFFF]/30 shadow-[0_0_100px_rgba(0,255,255,0.2)]"
            >
              {/* Left: Crystallization Viz */}
              <div className="w-[45%] h-full bg-[#020408]/40 border-r border-[#00FFFF]/10 relative flex items-center justify-center overflow-hidden">
                 <div className="absolute inset-0 opacity-20">
                    <div className="scanline" />
                 </div>
                 <motion.div 
                   animate={{ 
                     rotateY: 360,
                     scale: [1, 1.1, 1],
                   }}
                   transition={{ duration: 10, repeat: Infinity, ease: "linear" }}
                   className="w-48 h-48 border-2 border-dashed rounded-lg border-[#00FFFF]/20 flex items-center justify-center relative"
                 >
                    <Box size={80} color={selectedAgent.color} className="drop-shadow-[0_0_30px_rgba(0,255,255,0.5)]" />
                    <div className="absolute inset-[-20px] border border-[#00FFFF]/10 rounded-full animate-pulse" />
                    <div className="absolute inset-[-40px] border-[0.5px] border-[#00FFFF]/5 rounded-full" />
                 </motion.div>
                 
                 <div className="absolute bottom-6 left-6 text-[10px] font-mono text-[#00FFFF]/40">
                    MODEL_GEOM: CRYSTALLIZED<br/>
                    COGNITIVE_HASH: 0x{Math.floor(Math.random()*0xFFFFFF).toString(16).toUpperCase()}
                 </div>
              </div>

              {/* Right: Technical Specs & Parameters */}
              <div className="flex-1 flex flex-col p-10 overflow-y-auto custom-scrollbar">
                <div className="flex justify-between items-start mb-6">
                  <div>
                    <h2 className="text-2xl font-black glow-text-cyan tracking-widest">{selectedAgent.name.toUpperCase()}</h2>
                    <div className="text-[10px] text-[#00FFFF]/50 font-mono mt-1 uppercase tracking-[0.2em]">{selectedAgent.author}</div>
                  </div>
                  <button onClick={() => setSelectedAgent(null)} className="p-2 text-white/30 hover:text-white transition-colors">
                    <X size={20} />
                  </button>
                </div>

                <p className="text-sm text-white/70 font-mono leading-relaxed mb-8">
                  {selectedAgent.description}
                </p>

                <div className="space-y-8 flex-1">
                   <div className="grid grid-cols-2 gap-8">
                      <div className="space-y-2">
                        <label className="text-[10px] font-bold text-[#FF5F1F] tracking-[0.2em] flex items-center gap-2">
                          <Zap size={10} /> CREATIVITY_INDEX
                        </label>
                        <div className="h-1 w-full bg-[#FF5F1F]/10 rounded-full overflow-hidden">
                           <div className="h-full bg-[#FF5F1F]" style={{ width: `${selectedAgent.defaultParams.temperature * 100}%` }} />
                        </div>
                      </div>
                      <div className="space-y-2">
                        <label className="text-[10px] font-bold text-[#39FF14] tracking-[0.2em] flex items-center gap-2">
                          <Box size={10} /> CONTEXT_THRESHOLD
                        </label>
                        <div className="h-1 w-full bg-[#39FF14]/10 rounded-full overflow-hidden">
                           <div className="h-full bg-[#39FF14]" style={{ width: `${(selectedAgent.defaultParams.contextLimit / 200000) * 100}%` }} />
                        </div>
                      </div>
                   </div>

                   <div className="space-y-2">
                      <label className="text-[10px] font-bold text-[#00FFFF]/50 tracking-[0.2em]">CORE_ENGINE</label>
                      <div className="p-3 bg-[#00FFFF]/5 border border-[#00FFFF]/20 text-[11px] font-mono text-[#00FFFF]">
                         {selectedAgent.defaultParams.model}
                      </div>
                   </div>

                   <div className="p-4 bg-[#FF5F1F]/5 border border-[#FF5F1F]/20 rounded-sm flex gap-4">
                      <Shield size={16} className="text-[#FF5F1F] shrink-0" />
                      <p className="text-[10px] text-[#FF5F1F]/80 font-mono leading-relaxed">
                        SECURITY_PROTOCOL: AGENT_RUNS_IN_SANDBOXED_ENV. ADHERE_TO_OIDC_GOVERNANCE.
                      </p>
                   </div>
                </div>

                <button 
                  onClick={() => setIsInstalled(true)}
                  className="mt-10 w-full py-4 bg-[#00FFFF]/10 border border-[#00FFFF]/40 text-[#00FFFF] font-black tracking-[0.5em] text-xs hover:bg-[#00FFFF]/20 hover:shadow-[0_0_30px_rgba(0,255,255,0.3)] transition-all"
                >
                  {isInstalled ? 'COLLECTED_TO_KOS' : 'INITIATE_FORGE_DOCKING'}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
