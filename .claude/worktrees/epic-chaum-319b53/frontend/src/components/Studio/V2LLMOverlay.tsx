import React from 'react';
import { Cpu } from 'lucide-react';
import LLMManager from '../LLMManager/LLMManager';
import { DynamicOverlay } from './DynamicOverlay';

interface Props {
  onClose: () => void;
}

export function V2LLMOverlay({ onClose }: Props) {
  return (
    <DynamicOverlay 
      title="NODE_LLM_MANAGER_G3" 
      defaultPosition={{ x: (typeof window !== 'undefined' ? window.innerWidth : 1200) / 2 - 450, y: 80 }}
      defaultSize={{ width: 900, height: 750 }}
      onClose={onClose}
    >
      <div className="flex-1 overflow-hidden h-full flex flex-col bg-[#020408]/40">
        <style>{`
          .llm-manager { color: white !important; }
          .provider-card { 
             background: rgba(0, 255, 255, 0.03) !important; 
             border: 1px solid rgba(0, 255, 255, 0.1) !important;
          }
          .provider-name { color: #00FFFF !important; }
          .btn-outline { 
             border: 1px solid rgba(0, 255, 255, 0.2) !important; 
             color: #00FFFF !important;
          }
          .btn-outline:hover { background: rgba(0, 255, 255, 0.1) !important; }
        `}</style>
        <div className="flex-1 overflow-y-auto custom-scrollbar p-6">
          <LLMManager />
        </div>
      </div>
    </DynamicOverlay>
  );
}
