import React from 'react';
import { useWorkflowStore } from '../../hooks/useWorkflowStore';
import { AlertTriangle, RotateCcw, ShieldAlert, ZapOff } from 'lucide-react';

interface Props {
  error: Error;
  version: 'v1' | 'v2';
}

const DiagnosticPanel: React.FC<Props> = ({ error, version }) => {
  const setUIVersion = useWorkflowStore((state) => state.setUIVersion);
  const setCognitiveMeshValue = useWorkflowStore((state) => state.setCognitiveMeshValue);

  const handleResetMesh = () => {
    // Reset risky KG3D-related flags to safe defaults
    setCognitiveMeshValue('synopticWeb', false);
    setCognitiveMeshValue('cycleDetection', false);
    setCognitiveMeshValue('neuralNebula', false);
    setCognitiveMeshValue('agenticPanels', false);
    console.info('[UX-REC] Cognitive mesh flags reset to safe defaults');
  };

  const handleSwitchToV1 = () => {
    setUIVersion('v1');
    console.info('[UX-REC] Switched to safe UI Version V1');
  };

  const isProduction = import.meta.env.MODE === 'production';

  return (
    <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-[#020408]/95 backdrop-blur-2xl p-6 font-mono">
      <div className="max-w-2xl w-full border border-red-500/30 bg-[#0a0c10] rounded-xl shadow-[0_0_50px_rgba(239,68,68,0.15)] overflow-hidden">
        {/* Header */}
        <div className="bg-red-500/10 border-b border-red-500/20 p-4 flex items-center gap-3">
          <AlertTriangle className="text-red-500" size={24} />
          <h1 className="text-white font-black tracking-tighter text-xl">SYSTEM_CRITICAL: UI_WHITEOUT_PREVENTED</h1>
        </div>

        {/* Content */}
        <div className="p-8 flex flex-col gap-6">
          <div className="space-y-2">
            <p className="text-white/60 text-sm uppercase tracking-widest">Error Signature</p>
            <div className="bg-black/40 border border-white/5 p-4 rounded-lg">
              <p className="text-red-400 font-bold text-lg">{error.name}: {error.message}</p>
            </div>
          </div>

          {!isProduction && (
            <div className="space-y-2">
              <p className="text-white/40 text-[10px] uppercase tracking-widest">Trace (Dev only)</p>
              <pre className="bg-black/60 p-4 rounded text-[10px] text-white/30 overflow-x-auto max-h-40 custom-scrollbar">
                {error.stack}
              </pre>
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">
            <button 
              onClick={handleSwitchToV1}
              className="flex items-center justify-between gap-4 p-4 bg-white/5 border border-white/10 hover:bg-white/10 hover:border-[#39FF14]/40 transition-all group rounded-lg"
            >
              <div className="flex flex-col items-start">
                <span className="text-white font-bold group-hover:text-[#39FF14]">SWITCH_TO_V1_SAFE</span>
                <span className="text-white/40 text-[10px]">RECOVERY_CORE_FALLBACK</span>
              </div>
              <ShieldAlert className="text-white/20 group-hover:text-[#39FF14]" size={20} />
            </button>

            <button 
              onClick={handleResetMesh}
              className="flex items-center justify-between gap-4 p-4 bg-white/5 border border-white/10 hover:bg-white/10 hover:border-blue-400/40 transition-all group rounded-lg"
            >
              <div className="flex flex-col items-start">
                <span className="text-white font-bold group-hover:text-blue-400">RESET_MESH_FLAGS</span>
                <span className="text-white/40 text-[10px]">TERMINATE_RISKY_SUBGRAPHS</span>
              </div>
              <RotateCcw className="text-white/20 group-hover:text-blue-400" size={20} />
            </button>
          </div>

          <div className="mt-4 pt-4 border-t border-white/5 flex justify-between items-center text-[10px] text-white/20">
            <span>PLATFORM_NODE: {version.toUpperCase()}</span>
            <span>UX_RECOVERY_PROTOCOL_V1.1</span>
          </div>
        </div>
      </div>
    </div>
  );
};

export default DiagnosticPanel;
