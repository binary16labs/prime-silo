import React from 'react';
import { motion } from 'framer-motion';
import { MessageSquare } from 'lucide-react';
import NotebookChat from '../Notebook/NotebookChat';
import { DynamicOverlay } from './DynamicOverlay';

interface Props {
  onClose: () => void;
}

export function V2ChatOverlay({ onClose }: Props) {
  return (
    <DynamicOverlay 
      title="COMMS_CHANNEL_G3" 
      defaultPosition={{ x: (typeof window !== 'undefined' ? window.innerWidth : 1200) - 500, y: 120 }}
      defaultSize={{ width: 450, height: 600 }}
      onClose={onClose}
      dockable={false}
    >
      <div className="h-full flex flex-col bg-[#020408]/40 h-full">
        <div className="flex-1 overflow-hidden">
          <NotebookChat />
        </div>
      </div>
    </DynamicOverlay>
  );
}
