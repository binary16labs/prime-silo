import { motion } from 'framer-motion';
import { useWorkflowStore } from '../../hooks/useWorkflowStore';
import { Clock, ChevronLeft, ChevronRight, Play, Pause, Zap, Activity } from 'lucide-react';
import { useMemo } from 'react';

export function TemporalAudit() {
  const { executionEvents, playbackIndex, setPlaybackIndex } = useWorkflowStore();

  const events = useMemo(() => {
    return executionEvents.filter(e => 
      e.type === 'node_started' || 
      e.type === 'node_completed' || 
      e.type === 'node_error' ||
      e.type === 'workflow_completed'
    );
  }, [executionEvents]);

  const currentIndex = playbackIndex !== null ? playbackIndex : events.length - 1;
  const progress = events.length > 0 ? (currentIndex / (events.length - 1)) * 100 : 0;

  return (
    <div className="flex flex-col h-[500px] glass-panel rounded-sm p-5 pointer-events-auto border-l-2 border-l-[#FF5F1F]/40 overflow-hidden relative">
      
      {/* Aesthetic Arc Gauge (Top Corner) */}
      <div className="absolute top-[-20px] right-[-20px] w-32 h-32 opacity-20 pointer-events-none">
        <svg viewBox="0 0 100 100" className="w-full h-full rotate-[-90deg]">
          <circle cx="50" cy="50" r="45" fill="none" stroke="#FF5F1F" strokeWidth="2" strokeDasharray="283" strokeDashoffset={283 - (283 * progress / 100)} />
          <circle cx="50" cy="50" r="35" fill="none" stroke="#00FFFF" strokeWidth="1" strokeDasharray="220" strokeDashoffset="110" className="animate-spin-slow" />
        </svg>
      </div>

      <div className="flex items-center justify-between mb-6 flex-shrink-0 relative z-10">
        <div className="flex flex-col">
          <h3 className="glow-text-orange text-[11px] font-black tracking-[0.3em] flex items-center gap-2 uppercase">
            <Clock className="w-3 h-3" />
            TEMPORAL_SCRUB
          </h3>
          <div className="text-[8px] text-[#FF5F1F]/40 font-mono mt-1">
            SYNC_INDEX: 0x{currentIndex.toString(16).toUpperCase()}
          </div>
        </div>
        
        <button 
          onClick={() => setPlaybackIndex(null)}
          className={`text-[9px] px-3 py-1 rounded-sm border font-black tracking-widest transition-all ${playbackIndex === null ? 'bg-[#FF5F1F]/20 text-[#FF5F1F] border-[#FF5F1F] shadow-[0_0_15px_rgba(255,95,31,0.3)]' : 'text-[#FF5F1F]/40 border-[#FF5F1F]/10 hover:border-[#FF5F1F]/40 hover:text-[#FF5F1F]'} uppercase`}
        >
          LIVE
        </button>
      </div>

      <div className="flex-1 overflow-y-auto custom-scrollbar relative pr-2 z-10">
        {/* The Timeline Energy Trail */}
        <div className="absolute left-3 top-0 bottom-0 w-[1px] bg-[#FF5F1F]/10" />
        <motion.div 
          className="absolute left-3 top-0 w-[2px] bg-[#FF5F1F] shadow-[0_0_10px_rgba(255,95,31,0.8)]"
          style={{ height: `${progress}%` }}
        />
        
        <div className="space-y-4 pl-8 relative pb-2">
          {events.map((event, i) => {
            const isSelected = i === currentIndex && playbackIndex !== null;
            const isPast = i < currentIndex;
            
            return (
              <motion.div 
                key={i}
                initial={{ x: -10, opacity: 0 }}
                animate={{ x: 0, opacity: 1 }}
                className={`relative cursor-pointer group transition-all ${isSelected ? 'scale-[1.02]' : 'opacity-40 hover:opacity-100'}`}
                onClick={() => setPlaybackIndex(i)}
              >
                {/* Checkpoint Node */}
                <div className={`absolute -left-[22px] w-4 h-4 rounded-full border-2 border-[#020408] z-10 transition-all flex items-center justify-center
                  ${isSelected ? 'bg-[#FF5F1F] scale-125 shadow-[0_0_15px_rgba(255,95,31,1)]' : 
                    isPast ? 'bg-[#FF5F1F]/40' : 'bg-white/5'}`}
                >
                  {isSelected && <Zap size={8} className="text-white animate-pulse" />}
                </div>
                
                <div className={`p-3 rounded-sm border transition-all ${isSelected ? 'bg-[#FF5F1F]/10 border-[#FF5F1F]/40 shadow-[0_0_20px_rgba(255,95,31,0.1)]' : 'bg-white/2 border-white/5'}`}>
                  <div className="flex justify-between items-center mb-1">
                    <span className={`text-[10px] font-black uppercase tracking-wider truncate w-32 ${isSelected ? 'text-[#FF5F1F]' : 'text-white'}`}>
                      {event.nodeId?.split('.').pop() || 'SYSTEM'}
                    </span>
                    <span className="text-[8px] opacity-30 font-mono tracking-tighter">
                      {typeof event.timestamp === 'string' ? event.timestamp.split('T')[1]?.slice(0, 5) || '00:00' : '00:00'}
                    </span>
                  </div>
                  <div className="text-[9px] opacity-60 font-mono leading-tight tracking-[0.1em]">
                    {event.type.split('_').join(' ').toUpperCase()}
                  </div>
                </div>
              </motion.div>
            );
          })}
        </div>
      </div>

      {/* Playback HUD Controls */}
      <div className="mt-4 pt-4 border-t border-white/5 flex flex-col gap-4 flex-shrink-0 relative z-10">
        <div className="flex justify-between items-center px-2">
           <button 
              className="text-white/20 hover:text-[#FF5F1F] transition-colors"
              onClick={() => currentIndex > 0 && setPlaybackIndex(currentIndex - 1)}
           >
             <ChevronLeft size={16} />
           </button>
           
           <div className="flex items-center gap-4">
              <button 
                onClick={() => playbackIndex === null ? setPlaybackIndex(events.length - 1) : setPlaybackIndex(null)}
                className="w-10 h-10 rounded-full border border-[#FF5F1F]/30 flex items-center justify-center hover:bg-[#FF5F1F]/10 transition-all"
              >
                 {playbackIndex === null ? <Pause size={18} className="text-[#FF5F1F]" /> : <Play size={18} className="text-[#FF5F1F]" />}
              </button>
           </div>

           <button 
              className="text-white/20 hover:text-[#FF5F1F] transition-colors"
              onClick={() => (events.length > 0 && currentIndex < events.length - 1) && setPlaybackIndex(currentIndex + 1)}
           >
             <ChevronRight size={16} />
           </button>
        </div>

        <div className="flex justify-between text-[8px] font-bold text-[#FF5F1F]/40 tracking-[0.3em] uppercase">
           <span>0x00</span>
           <div className="flex items-center gap-2">
              <Activity size={8} />
              <span>TIME_RECONSTRUCTION</span>
           </div>
           <span>0x{events.length.toString(16).toUpperCase()}</span>
        </div>
      </div>

      <style>{`
        .animate-spin-slow {
          animation: spin 8s linear infinite;
        }
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}
