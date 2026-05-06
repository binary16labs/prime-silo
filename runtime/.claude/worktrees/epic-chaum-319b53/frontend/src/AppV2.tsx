import React, { useState } from 'react';
import { useWorkflowStore } from './hooks/useWorkflowStore';
import { GodModeHUD } from './components/Studio/GodModeHUD';
import { SwarmCanvas3D } from './components/Studio/SwarmCanvas3D';
import { CodeGraphCanvas } from './components/Studio/CodeGraphCanvas';
import { SynopticWeb } from './components/Notebook/SynopticWeb';
import { MarketplaceV2 } from './components/MarketplaceV2';
import { OmniDialog } from './components/Studio/OmniDialog';
import SourcePanel from './components/Studio/SourcePanel';
import SymbolInspector from './components/Studio/SymbolInspector';
import { HybridLayout } from './components/Studio/HybridLayout';
import ExecutionAuditHub from './components/Studio/ExecutionAuditHub';

import ErrorBoundary from './components/Shared/ErrorBoundary';

export default function AppV2() {
  const [viewMode, setViewMode] = useState<'swarm' | 'knowledge' | 'marketplace' | 'documents' | 'graph'>('graph');

  return (
    <div className="v2-root obsidian-theme" data-ui-version="v2">
      <GodModeHUD onViewChange={setViewMode} currentView={viewMode} />
      
      <main className="v2-main-content">
        <ErrorBoundary name="V2Content">
            {viewMode === 'swarm' && <SwarmCanvas3D />}
            {viewMode === 'knowledge' && <SynopticWeb />}
            {viewMode === 'marketplace' && <MarketplaceV2 />}
            
            {viewMode === 'graph' && (
              <HybridLayout 
                canvas={<CodeGraphCanvas />}
                rightPanel={<SymbolInspector />}
              />
            )}

            {viewMode === 'documents' && (
              <HybridLayout 
                canvas={<CodeGraphCanvas />}
                leftPanel={<SourcePanel />}
                rightPanel={<SymbolInspector />}
              />
            )}
        </ErrorBoundary>

        {/* Floating UI Elements */}
        <OmniDialog />
      </main>

      {/* Global Observability Overlay */}
      <ErrorBoundary name="AuditHub">
          <ExecutionAuditHub />
      </ErrorBoundary>
    </div>
  );
}
