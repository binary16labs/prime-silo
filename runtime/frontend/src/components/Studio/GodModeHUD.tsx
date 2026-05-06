import {
  AlertTriangle, ShieldAlert, Activity, Cpu, Terminal, Power, ExternalLink, Zap,
  Settings, Eye, FastForward, MessageSquare, Link, Share2, RefreshCw, File, BookOpen,
  Sparkles, History
} from 'lucide-react';
import { useEffect, useState, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useWorkflowStore } from '../../hooks/useWorkflowStore';
import { useWorkspaceStore } from '../../hooks/useWorkspaceStore';
import { API_BASE_URL, GOVERNANCE_HEADERS } from '../../constants';
import V2WorkspaceSelector from './V2WorkspaceSelector';
import { DynamicOverlay } from './DynamicOverlay';
import { GraphManager } from './GraphManager';
import { WikiHub } from './WikiHub';

function SonicWave({ active }: { active: boolean }) {
  return (
    <div className="flex items-center gap-[2px] h-4">
      {Array.from({ length: 12 }).map((_, i) => (
        <motion.div
          key={i}
          animate={{
            height: active ? [4, 16, 8, 14, 6][i % 5] : 4,
            opacity: active ? [0.4, 1, 0.6, 0.8, 0.5][i % 5] : 0.2
          }}
          transition={{
            duration: 0.5,
            repeat: Infinity,
            repeatType: "reverse",
            delay: i * 0.05
          }}
          className="w-[2px] bg-[#00FFFF] rounded-full"
        />
      ))}
    </div>
  );
}

function SynapticStream() {
  const executionEvents = useWorkflowStore((state) => state.executionEvents);
  const currentWorkspace = useWorkspaceStore((state) => state.currentWorkspace);
  const [backendLogs, setBackendLogs] = useState<any[]>([]);
  
  // Real-time backend log polling
  useEffect(() => {
    const fetchLogs = async () => {
      try {
        const resp = await fetch(`${API_BASE_URL}/api/system/logs?limit=20`, {
          headers: { ...GOVERNANCE_HEADERS }
        });
        if (resp.ok) {
          const data = await resp.json();
          setBackendLogs(data.logs || []);
        }
      } catch (e) {
        // Fail silently to avoid HUD disruption
      }
    };
    const interval = setInterval(fetchLogs, 2000);
    fetchLogs();
    return () => clearInterval(interval);
  }, []);

  const stream = useMemo(() => {
    // 1. Process Swarm Events
    const baseStream = executionEvents.slice(-10).map((event, i) => {
      let timestamp = '00:00:00';
      try {
        timestamp = typeof event.timestamp === 'string' ? event.timestamp : new Date(event.timestamp).toISOString().split('T')[1].slice(0, -5);
      } catch (e) {
        timestamp = 'ERR_TS';
      }
      const addr = Math.floor(Math.random() * 0xFFFFFF).toString(16).toUpperCase().padStart(6, '0');
      
      let text = event.type.toUpperCase();
      if (event.nodeId) text += ` [${event.nodeId.split('.').pop()}]`;
      if (event.data?.message) text += ` :: ${event.data.message}`;

      return {
        id: `evt-${i}`,
        timestamp: event.timestamp,
        text: `[${timestamp}] >> 0x${addr} >> ${text}`,
        type: event.type.includes('error') ? 'warn' : event.type.includes('completed') ? 'success' : 'info'
      };
    });
    // 2. Process Backend System Logs
    const systemStream = backendLogs.map((log, i) => ({
      id: `sys-${log.id || i}`,
      timestamp: log.timestamp,
      text: `[${log.timestamp.split('T')[1].split('.')[0]}] :: SYSTEM :: ${log.level} :: ${log.message}`,
      type: log.level === 'ERROR' || log.level === 'CRITICAL' ? 'warn' : 'info',
      source: 'backend'
    }));

    // Merge and sort by timestamp
    return [...baseStream, ...systemStream]
      .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
      .slice(-20);
  }, [executionEvents, backendLogs, currentWorkspace]);

  return (
    <div className="flex flex-col justify-end h-full font-mono text-[9px] leading-relaxed tracking-wider overflow-y-auto custom-scrollbar p-4">
      <AnimatePresence initial={false}>
        {stream.map((msg) => (
          <motion.div 
            key={msg.id}
            initial={{ x: -20, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            className={`${
              msg.type === 'warn' ? 'glow-text-orange glitch-text' : 
              msg.type === 'success' ? 'glow-text-green' : 
              'glow-text-cyan opacity-80'
            }`}
          >
            {msg.text}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

interface HUDProps {
  onViewChange: (view: any) => void;
  currentView: string;
  onToggleChat: () => void;
  isChatOpen: boolean;
}

export function GodModeHUD({ onViewChange, currentView, onToggleChat, isChatOpen }: HUDProps) {
  const { 
    uiVersion, 
    toggleUIVersion, 
    tokenUsage, 
    executionPhase, 
    viewMode, 
    setIsCodeGraphScanOpen, 
    isGraphManagerOpen, 
    setIsGraphManagerOpen,
    isLLMManagerOpen,
    setIsLLMManagerOpen,
    setWikiHubOpen,
    isWikiHubOpen,
    isManifestPanelOpen,
    isRunsPanelOpen,
    toggleManifestPanel,
    toggleRunsPanel
  } = useWorkflowStore() as any;
  const { currentWorkspace } = useWorkspaceStore();
  const [glitchMode, setGlitchMode] = useState(false);
  const [lowPower, setLowPower] = useState(false);
  
  const activeRuns = 4; // Placeholder

  return (
    <div className="absolute inset-0 pointer-events-none z-50 overflow-hidden">
      
      {/* 1. Top-Left: System Diagnostics - Tiled Top-Left */}
      <DynamicOverlay 
        title="SYS_DIAGNOSTICS_C3" 
        defaultPosition={{ x: 32, y: 32 }}
        defaultSize={{ width: 380, height: 320 }}
      >
        <div className="p-6 space-y-6">
          <div className="flex justify-between items-center mb-4">
            <h1 className="glow-text-cyan text-[13px] font-black flex items-center gap-2 tracking-[0.3em]">
              <Activity className="w-4 h-4" />
              BENNY_CORE_G3
            </h1>
            <SonicWave active={executionPhase === 'running'} />
          </div>

          <div className="flex items-center gap-4 bg-white/5 p-4 rounded-sm border border-[#00FFFF]/10">
             <div className="flex flex-col gap-1">
                <span className="text-[8px] font-black text-[#00FFFF]/40 tracking-[0.2em] mb-1">ACTIVE_CLUSTER</span>
                <V2WorkspaceSelector />
             </div>
             <div className="flex-1 text-right">
                <span className="text-[8px] font-black text-[#00FFFF]/40 tracking-[0.2em] mb-1">NODE_STATUS</span>
                <span className={`text-[10px] font-black tracking-widest ${executionPhase === 'failed' ? 'glow-text-orange glitch-text' : 'glow-text-green'}`}>
                  {executionPhase === 'running' ? 'OPTIMIZING' : 'STABLE_IDLE'}
                </span>
             </div>
          </div>
          
          <div className="space-y-3 text-[10px] text-[#00FFFF]/70 uppercase font-black tracking-widest">
            <div className="flex justify-between items-baseline">
              <span>NEURAL_THROUGHPUT</span>
              <span className="glow-text-cyan">{(tokenUsage / 60).toFixed(1)} T/S</span>
            </div>
            
            <div className="h-[1px] w-full bg-[#00FFFF]/10 my-4" />
            
            <div className="flex gap-4">
               <button onClick={() => setGlitchMode(!glitchMode)} className={`btn-pill flex-1 ${glitchMode ? 'active' : ''}`}>
                 <Zap size={12} /> AURORA
               </button>
               <button onClick={() => setLowPower(!lowPower)} className={`btn-pill flex-1 ${lowPower ? 'active' : ''}`}>
                 <Eye size={12} /> LOD_MAX
               </button>
               {viewMode === 'graph' && (
                 <button onClick={() => setIsCodeGraphScanOpen(true)} className="btn-pill-orange btn-pill flex-1 active">
                   <RefreshCw size={12} className="animate-pulse" /> NEURAL_SCAN
                 </button>
               )}
            </div>
          </div>
        </div>
      </DynamicOverlay>

      {/* 2. Top-Center: Navigation Control */}
      <DynamicOverlay 
        title="NAVIGATION_MODAL" 
        defaultPosition={{ x: (typeof window !== 'undefined' ? window.innerWidth : 1200) / 2 - 250, y: 24 }}
        defaultSize={{ width: 500, height: 80 }}
        minSize={{ width: 450, height: 80 }}
      >
        <div className="flex items-center justify-center h-full gap-2 px-2">
          <button onClick={() => onViewChange('swarm')} className={`btn-pill ${currentView === 'swarm' ? 'active' : ''}`}>
            <FastForward size={14} /> SWARM
          </button>
          <button onClick={() => onViewChange('knowledge')} className={`btn-pill ${currentView === 'knowledge' ? 'active' : ''}`}>
            <Activity size={14} /> NEURAL
          </button>
          <button onClick={() => onViewChange('marketplace')} className={`btn-pill ${currentView === 'marketplace' ? 'active' : ''}`}>
            <Cpu size={14} /> FORGE
          </button>
          <button onClick={() => onViewChange('documents')} className={`btn-pill ${currentView === 'documents' ? 'active' : ''}`}>
            <File size={14} /> DOCS
          </button>
          <div className="w-[1px] h-6 bg-[#00FFFF]/20 mx-1" />
          <button 
            onClick={() => setIsLLMManagerOpen(!isLLMManagerOpen)} 
            className={`btn-pill ${isLLMManagerOpen ? 'active' : ''}`}
          >
            <Link size={14} /> LINK
          </button>
          <button onClick={() => onViewChange('graph')} className={`btn-pill ${currentView === 'graph' ? 'active' : ''}`}>
            <Share2 size={14} /> GRAPH
          </button>
          <button 
            onClick={() => setWikiHubOpen(true)} 
            className={`btn-pill hover:text-[#FF00FF] transition-all ${isWikiHubOpen ? 'active' : ''}`}
          >
            <BookOpen size={14} /> WIKI
          </button>
          <button onClick={onToggleChat} className={`btn-pill-orange btn-pill ${isChatOpen ? 'active' : ''}`}>
            <MessageSquare size={14} /> COMMS
          </button>
          <div className="w-[1px] h-6 bg-white/10 mx-1" />
          <button
            onClick={() => toggleManifestPanel()}
            className={`btn-pill hover:text-emerald-400 transition-all ${isManifestPanelOpen ? 'active' : ''}`}
            title="Plan a new manifest"
          >
            <Sparkles size={14} /> PLAN
          </button>
          <button
            onClick={() => toggleRunsPanel()}
            className={`btn-pill hover:text-blue-400 transition-all ${isRunsPanelOpen ? 'active' : ''}`}
            title="Run history"
          >
            <History size={14} /> RUNS
          </button>
          <div className="w-[1px] h-6 bg-white/10 mx-1" />
          <button 
            onClick={() => setIsGraphManagerOpen(!isGraphManagerOpen)} 
            className={`btn-pill ${isGraphManagerOpen ? 'active' : ''}`}
          >
            <Settings size={14} className={isGraphManagerOpen ? "animate-spin" : ""} /> MANAGE
          </button>
        </div>
      </DynamicOverlay>

      {/* 3. Top-Right: Kill Switch & Settings (Pinned to absolute corner) */}
      <div className="absolute top-4 right-4 flex flex-col items-end gap-4 pointer-events-auto z-50">
        <button className="relative group flex items-center justify-center w-20 h-20 rounded-full bg-[#020408]/80 border-2 border-[#FF5F1F] shadow-[0_0_20px_rgba(255,95,31,0.2)] hover:shadow-[0_0_40px_rgba(255,95,31,0.6)] transition-all duration-500 backdrop-blur-xl">
          <div className="absolute inset-[-4px] border-[1px] border-dashed border-[#FF5F1F]/40 rounded-full animate-spin-slow" />
          <div className="flex flex-col items-center gap-1 z-10">
            <Power className="w-6 h-6 text-[#FF5F1F] drop-shadow-[0_0_10px_rgba(255,95,31,1)]" />
            <span className="text-[8px] font-black text-[#FF5F1F] tracking-[0.2em]">HALT</span>
          </div>
        </button>
        <button onClick={toggleUIVersion} className="btn-pill px-4 py-2 bg-black/40 border border-white/10 hover:bg-white/10 transition-all text-[#00FFFF] text-[9px] font-black tracking-widest flex items-center gap-2">
          <ExternalLink size={12} /> EXIT_OS
        </button>
      </div>

      {/* 4. Bottom-Left: Security Protocol - Tiled Bottom-Left */}
      <DynamicOverlay 
        title="SEC_AUDIT_LOG" 
        defaultPosition={{ x: 32, y: (typeof window !== 'undefined' ? window.innerHeight : 800) - 360 }}
        defaultSize={{ width: 380, height: 320 }}
      >
        <div className="p-6 h-full flex flex-col">
          <h2 className="glow-text-orange text-[11px] font-black mb-4 flex items-center gap-2 tracking-[0.3em] uppercase">
            <ShieldAlert className="w-4 h-4" /> SEC_PROTOCOL
          </h2>
          <div className="flex-1 overflow-y-auto space-y-3 text-[9px] font-mono pr-2 custom-scrollbar">
             <div className="p-3 border border-[#FF5F1F]/20 bg-[#FF5F1F]/5 rounded-sm text-[#FF5F1F]/80">
                [CRIT] AUTH_TOKEN_EXPIRING :: REFRESH_PENDING
             </div>
             <div className="p-3 border border-[#00FFFF]/20 bg-[#00FFFF]/5 rounded-sm text-[#00FFFF]/60">
                [LOG] WORKSPACE_SYNC_COMPLETE: {currentWorkspace?.toUpperCase() || 'DEFAULT'}
             </div>
             <div className="p-3 border border-[#39FF14]/20 bg-[#39FF14]/5 rounded-sm glow-text-green">
                [OK] NP_KERNEL: LOCAL_ACCEL_ENABLED
             </div>
          </div>
        </div>
      </DynamicOverlay>

      {/* 5. Bottom-Right: Synaptic Stream - Tiled Bottom-Right */}
      <DynamicOverlay 
        title="SYNAPTIC_PULSE_STREAM" 
        defaultPosition={{ x: (typeof window !== 'undefined' ? window.innerWidth : 1200) - 580, y: (typeof window !== 'undefined' ? window.innerHeight : 800) - 480 }}
        defaultSize={{ width: 550, height: 440 }}
      >
        <div className="h-full flex flex-col">
          <div className="px-6 py-4 border-b border-[#00FFFF]/10 flex justify-between items-center bg-white/2">
            <h2 className="glow-text-cyan text-[11px] font-black flex items-center gap-2 tracking-[0.3em] uppercase">
              <Cpu className="w-4 h-4" /> SYNAPTIC
            </h2>
            <div className="text-[8px] text-[#00FFFF]/40 font-mono tracking-widest uppercase">
              BUFFER_0x{Math.floor(Math.random()*255).toString(16).toUpperCase()}
            </div>
          </div>
          <div className="flex-1 overflow-hidden">
            <SynapticStream />
          </div>
        </div>
      </DynamicOverlay>

      {/* 6. Bottom-Center: Intent Broadcast */}
      <DynamicOverlay 
        title="INTENT_BROADCAST_LINK" 
        defaultPosition={{ x: (typeof window !== 'undefined' ? window.innerWidth : 1200) / 2 - 400, y: (typeof window !== 'undefined' ? window.innerHeight : 800) - 150 }}
        defaultSize={{ width: 800, height: 80 }}
        minSize={{ width: 500, height: 80 }}
      >
        <div className="flex items-center gap-4 h-full px-6 bg-[#020408]/60">
          <Terminal className="w-5 h-5 text-[#00FFFF] animate-pulse" />
          <input 
            type="text" 
            placeholder="BROADCAST_INTENT >> e.g. 'Optimize graph traversal'"
            className="flex-1 bg-transparent border-none outline-none text-[12px] font-mono text-white placeholder:text-[#00FFFF]/30 tracking-[0.1em] font-black"
          />
          <button className="btn-pill h-10 px-8 bg-[#00FFFF]/10 border border-[#00FFFF]/60 text-[#00FFFF] text-[10px] font-black tracking-[0.4em] hover:bg-[#00FFFF]/20">
             EXECUTE
          </button>
        </div>
      </DynamicOverlay>
 
      <AnimatePresence>
        {isWikiHubOpen && <WikiHub />}
      </AnimatePresence>
     </div>
  );
}
