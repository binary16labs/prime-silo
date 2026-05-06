import { useState, useEffect, useRef } from 'react';
import { useWorkspaceStore } from '../../hooks/useWorkspaceStore';
import { ChevronDown, Check, Folder, Plus, CornerDownLeft } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

export default function V2WorkspaceSelector() {
  const { currentWorkspace, workspaces, setCurrentWorkspace, fetchWorkspaces, createWorkspace } = useWorkspaceStore() as any;
  const [isOpen, setIsOpen] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetchWorkspaces();
  }, [fetchWorkspaces]);

  useEffect(() => {
    if (isCreating) inputRef.current?.focus();
  }, [isCreating]);

  const handleCreate = async () => {
    const sanitized = newName.trim().replace(/[^a-zA-Z0-9-_]/g, '-');
    if (!sanitized) return;
    await createWorkspace(sanitized);
    setNewName('');
    setIsCreating(false);
    setIsOpen(false);
  };

  const displayId = typeof currentWorkspace === 'string' ? currentWorkspace : (currentWorkspace as any)?.id || 'SELECT_WS';

  return (
    <div className="relative pointer-events-auto">
      <button 
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-3 px-4 py-1.5 rounded-full border border-[#00FFFF]/30 bg-[#00FFFF]/5 hover:bg-[#00FFFF]/10 transition-all text-[#00FFFF] font-black text-[10px] tracking-[0.2em] group"
      >
        <Folder size={12} className="opacity-60 group-hover:opacity-100 transition-opacity" />
        <span className="max-w-[120px] overflow-hidden text-ellipsis whitespace-nowrap">
          {displayId.toUpperCase()}
        </span>
        <ChevronDown size={12} className={`transition-transform duration-300 ${isOpen ? 'rotate-180' : ''}`} />
      </button>

      <AnimatePresence>
        {isOpen && (
          <>
            <div className="fixed inset-0 z-[-1]" onClick={() => setIsOpen(false)} />
            <motion.div 
              initial={{ opacity: 0, y: 10, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 10, scale: 0.95 }}
              className="absolute left-0 mt-3 w-64 glass-panel z-50 p-2 border-[#00FFFF]/20 shadow-[0_10px_40px_rgba(0,0,0,0.5)] bg-[#020408]/90"
            >
              <div className="text-[8px] font-black text-[#00FFFF]/40 px-3 py-2 tracking-[0.3em] border-b border-[#00FFFF]/10 mb-2">
                SELECT_CONTEXT_0x1F
              </div>
              <div className="max-h-60 overflow-y-auto custom-scrollbar">
                {workspaces.map((ws: any) => {
                  const wsId = typeof ws === 'string' ? ws : (ws as any)?.id || '???';
                  const isActive = wsId === displayId;
                  
                  return (
                    <button
                      key={wsId}
                      onClick={() => {
                        setCurrentWorkspace(wsId);
                        setIsOpen(false);
                      }}
                      className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-sm transition-all text-left text-[10px] font-bold tracking-wider ${
                        isActive 
                        ? 'bg-[#00FFFF]/20 text-[#00FFFF] border border-[#00FFFF]/30 shadow-[0_0_15px_rgba(0,255,255,0.2)]' 
                        : 'text-white/40 hover:text-white hover:bg-white/5'
                      }`}
                    >
                      <Folder size={12} className={isActive ? 'text-[#00FFFF]' : 'text-white/20'} />
                      <span className="flex-1">{wsId}</span>
                      {isActive && <Check size={12} className="text-[#00FFFF]" />}
                    </button>
                  );
                })}
              </div>
              
              <div className="mt-2 pt-2 border-t border-[#00FFFF]/10">
                {isCreating ? (
                  <div className="flex items-center gap-2 px-3 py-1.5">
                    <input
                      ref={inputRef}
                      value={newName}
                      onChange={(e) => setNewName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleCreate();
                        if (e.key === 'Escape') { setIsCreating(false); setNewName(''); }
                      }}
                      placeholder="cluster_name"
                      className="flex-1 bg-transparent border-b border-[#00FFFF]/40 text-[#00FFFF] text-[9px] font-black tracking-wider placeholder-[#00FFFF]/20 outline-none py-1"
                    />
                    <button
                      onClick={handleCreate}
                      disabled={!newName.trim()}
                      className="text-[#00FFFF]/60 hover:text-[#00FFFF] disabled:opacity-20 transition-colors"
                    >
                      <CornerDownLeft size={11} />
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => setIsCreating(true)}
                    className="w-full flex items-center gap-3 px-3 py-2 rounded-sm text-[9px] font-black text-[#00FFFF]/60 hover:text-[#00FFFF] hover:bg-[#00FFFF]/10 transition-all uppercase tracking-[0.2em]"
                  >
                    <Plus size={12} />
                    Initialize_New_Cluster
                  </button>
                )}
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}
