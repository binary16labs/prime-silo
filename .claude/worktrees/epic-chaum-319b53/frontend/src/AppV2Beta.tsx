import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useWorkflowStore } from './hooks/useWorkflowStore';
import { GodModeHUD } from './components/Studio/GodModeHUD';
import { SwarmCanvas3D } from './components/Studio/SwarmCanvas3D';
import { SynopticWeb } from './components/Notebook/SynopticWeb';
import { MarketplaceV2 } from './components/MarketplaceV2';
import { OmniDialog } from './components/Studio/OmniDialog';
import { TemporalAudit } from './components/Studio/TemporalAudit';
import ExecutionAuditHub from './components/Studio/ExecutionAuditHub';
import ErrorBoundary from './components/Shared/ErrorBoundary';
import { V2ChatOverlay } from './components/Studio/V2ChatOverlay';
import { V2LLMOverlay } from './components/Studio/V2LLMOverlay';
import { CodeGraphCanvas } from './components/Studio/CodeGraphCanvas';
import { GraphNexusController } from './components/Studio/GraphNexusController';
import { HybridLayout } from './components/Studio/HybridLayout';
import V2GraphSelector from './components/Studio/V2GraphSelector';
import DocumentManager from './components/Documents/DocumentManager';

export default function AppV2Beta() {
  const { viewMode, setViewMode, uiVersion } = useWorkflowStore();
  const [isChatOpen, setIsChatOpen] = useState(false);

  if (uiVersion !== 'v2') return null;

  return (
    <div className="v2-root obsidian-theme absolute inset-0 overflow-hidden" data-ui-version="v2">
      <div className="scanline z-50 pointer-events-none" />
      
      {/* Main Edge-to-Edge Canvas Area */}
      <main className="v2-main-content absolute inset-0 z-0">
        <AnimatePresence mode="wait">
          <motion.div
            key={viewMode}
            initial={{ scale: 1.1, opacity: 0, filter: 'blur(10px)' }}
            animate={{ scale: 1, opacity: 1, filter: 'blur(0px)' }}
            exit={{ scale: 0.9, opacity: 0, filter: 'blur(20px)' }}
            transition={{ duration: 0.8, ease: [0.22, 1, 0.36, 1] }}
            className="w-full h-full"
          >
            {viewMode === 'swarm' && <SwarmCanvas3D />}
            {viewMode === 'knowledge' && <SynopticWeb />}
            {viewMode === 'marketplace' && <MarketplaceV2 />}
            {viewMode === 'documents' && <DocumentManager />}
            {viewMode === 'llm' && <V2LLMOverlay onClose={() => setViewMode('swarm')} />}
            {viewMode === 'graph' && <CodeGraphCanvas />}
          </motion.div>
        </AnimatePresence>
        
        <div className="z-30 pointer-events-none absolute inset-0">
           <OmniDialog />
        </div>
        
        {/* Floating HUD controls */}
        <GodModeHUD 
          onViewChange={setViewMode} 
          currentView={viewMode} 
          onToggleChat={() => setIsChatOpen(!isChatOpen)}
          isChatOpen={isChatOpen}
        />

        {/* Universal Floating Windows Layer */}
        <V2GraphSelector />
        <GraphNexusController />
        <AnimatePresence>
          {isChatOpen && (
            <V2ChatOverlay onClose={() => setIsChatOpen(false)} />
          )}
        </AnimatePresence>
        
        <ErrorBoundary name="AuditHub">
          <ExecutionAuditHub />
        </ErrorBoundary>
      </main>
    </div>
  );
}
