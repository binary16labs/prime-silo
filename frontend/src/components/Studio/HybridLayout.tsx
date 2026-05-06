import React, { useState } from 'react';
import { motion } from 'framer-motion';

interface HybridLayoutProps {
  canvas: React.ReactNode;
  leftPanel?: React.ReactNode;
  rightPanel?: React.ReactNode;
  bottomPanel?: React.ReactNode;
}

export function HybridLayout({ canvas, leftPanel, rightPanel, bottomPanel }: HybridLayoutProps) {
  return (
    <div className="absolute inset-0 flex overflow-hidden z-0">
      {/* Left Dock */}
      {leftPanel && (
        <div className="relative z-10 flex-shrink-0 w-[400px] border-r border-[#00FFFF]/20 bg-[#020408]/80 backdrop-blur-xl">
          {leftPanel}
        </div>
      )}

      {/* Center Canvas */}
      <div className="flex-1 relative z-0 flex flex-col">
        <div className="flex-1 relative z-0">
           {canvas}
        </div>
        
        {/* Bottom Dock */}
        {bottomPanel && (
          <div className="relative z-10 flex-shrink-0 h-[300px] border-t border-[#00FFFF]/20 bg-[#020408]/80 backdrop-blur-xl">
            {bottomPanel}
          </div>
        )}
      </div>

      {/* Right Dock */}
      {rightPanel && (
        <div className="relative z-10 flex-shrink-0 w-[400px] border-l border-[#00FFFF]/20 bg-[#020408]/80 backdrop-blur-xl">
          {rightPanel}
        </div>
      )}
    </div>
  );
}
