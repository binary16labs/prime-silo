import React, { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Check, X, Info, Zap, ChevronRight } from 'lucide-react';
import { API_BASE_URL, GOVERNANCE_HEADERS } from '../../../constants';

/**
 * Synoptic Web Proposal Panel (KG3D-F8)
 * Interface for Human-in-the-loop ingestion approval.
 */
export const ProposalPanel: React.FC = () => {
  const [proposals, setProposals] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  const fetchProposals = async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE_URL}/api/kg3d/proposals`, {
        headers: { ...GOVERNANCE_HEADERS }
      });
      if (res.ok) {
        setProposals(await res.json());
      }
    } catch (e) {
      console.error("Failed to fetch proposals:", e);
    } finally {
      setLoading(false);
    }
  };

  const handeAction = async (id: string, action: 'approve' | 'reject') => {
    try {
      const res = await fetch(`${API_BASE_URL}/api/kg3d/proposals/${id}/${action}`, {
        method: 'POST',
        headers: { ...GOVERNANCE_HEADERS }
      });
      if (res.ok) {
        setProposals(prev => prev.filter(p => p.id !== id));
      }
    } catch (e) {
        console.error(`Failed to ${action} proposal:`, e);
    }
  };

  useEffect(() => {
    fetchProposals();
    const interval = setInterval(fetchProposals, 5000);
    return () => clearInterval(interval);
  }, []);

  if (proposals.length === 0 && !loading) return null;

  return (
    <div className="absolute top-32 right-8 w-80 z-50 space-y-4">
      <AnimatePresence>
        {proposals.map((item) => (
          <motion.div
            key={item.id}
            initial={{ opacity: 0, x: 50, scale: 0.9 }}
            animate={{ opacity: 1, x: 0, scale: 1 }}
            exit={{ opacity: 0, scale: 0.5 }}
            className="p-4 bg-[#020408]/80 border border-[#39FF14]/40 backdrop-blur-xl rounded shadow-[0_0_20px_rgba(57,255,20,0.1)] transition-all"
          >
            <div className="flex items-center gap-2 mb-3">
              <Zap size={14} className="text-[#39FF14]" />
              <span className="text-[10px] font-black text-[#39FF14] tracking-[0.2em] uppercase">CONCEPT_PROPOSAL</span>
            </div>
            
            <div className="space-y-2 mb-4">
               {item.proposal.nodes_upsert.map((n: any) => (
                 <div key={n.id} className="text-[11px] font-bold text-white tracking-widest flex items-center gap-2">
                    <ChevronRight size={12} className="text-[#39FF14]" />
                    {n.display_name}
                 </div>
               ))}
               <p className="text-[9px] text-white/40 italic leading-snug">
                 {item.proposal.rationale_md}
               </p>
            </div>

            <div className="flex gap-2">
              <button 
                onClick={() => handeAction(item.id, 'approve')}
                className="flex-1 py-1.5 bg-[#39FF14]/20 border border-[#39FF14]/40 text-[#39FF14] text-[9px] font-black tracking-widest hover:bg-[#39FF14]/40 transition-all flex items-center justify-center gap-2"
              >
                <Check size={12} /> APPROVE
              </button>
              <button 
                onClick={() => handeAction(item.id, 'reject')}
                className="flex-1 py-1.5 bg-red-500/10 border border-red-500/40 text-red-500 text-[9px] font-black tracking-widest hover:bg-red-500/20 transition-all flex items-center justify-center gap-2"
              >
                <X size={12} /> IGNORE
              </button>
            </div>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
};
