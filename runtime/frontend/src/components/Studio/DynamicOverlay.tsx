import React, { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { GripHorizontal, X, Minus, ChevronUp, ChevronDown, Maximize2 } from 'lucide-react';

interface DynamicOverlayProps {
  children: React.ReactNode;
  title: string;
  defaultPosition?: { x: number; y: number };
  defaultSize?: { width: number | string; height: number | string };
  minSize?: { width: number; height: number };
  onClose?: () => void;
  className?: string;
  id?: string;
  dockable?: boolean;
  defaultDocked?: boolean;
}

export function DynamicOverlay({ 
  children, 
  title, 
  defaultPosition = { x: 0, y: 0 }, 
  defaultSize = { width: 400, height: 300 },
  minSize = { width: 250, height: 150 },
  onClose,
  className = "",
  id,
  dockable = false,
  defaultDocked = false // Default to floating for better OS feel
}: DynamicOverlayProps) {
  const [size, setSize] = useState(defaultSize);
  const [isResizing, setIsResizing] = useState(false);
  const [isDocked, setIsDocked] = useState(defaultDocked);
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [isMinimized, setIsMinimized] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Custom Resize Logic
  const handleResizeStart = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsResizing(true);

    const startX = e.clientX;
    const startY = e.clientY;
    const startWidth = containerRef.current?.offsetWidth || 0;
    const startHeight = containerRef.current?.offsetHeight || 0;

    const onMouseMove = (moveEvent: MouseEvent) => {
      const newWidth = Math.max(minSize.width, startWidth + (moveEvent.clientX - startX));
      const newHeight = Math.max(minSize.height, startHeight + (moveEvent.clientY - startY));
      setSize({ width: newWidth, height: newHeight });
    };

    const onMouseUp = () => {
      setIsResizing(false);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  };

  if (isMinimized) {
    return (
      <motion.div 
        layoutId={`window-${id || title}`}
        className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[200] pointer-events-auto"
      >
        <button 
          onClick={() => setIsMinimized(false)}
          className="flex items-center gap-2 px-4 py-2 bg-[#020408]/80 border border-[#00FFFF]/40 rounded-full backdrop-blur-md hover:border-[#00FFFF] transition-all group shadow-[0_0_20px_rgba(0,255,255,0.1)]"
        >
          <div className="w-2 h-2 rounded-full bg-[#00FFFF] animate-pulse" />
          <span className="text-[10px] font-black tracking-[0.2em] text-[#00FFFF]/80 uppercase group-hover:text-[#00FFFF]">
            {title}
          </span>
          <Maximize2 size={12} className="text-[#00FFFF]/40 ml-2" />
        </button>
      </motion.div>
    );
  }

  if (dockable && isDocked) {
    return (
      <div className={`h-full w-full flex flex-col overflow-hidden pointer-events-auto border-[#00FFFF]/20 bg-[#020408]/80 ${className} ${isCollapsed ? 'h-10' : ''}`} id={id}>
         {/* Drag & Header Handle */}
        <div className="h-10 px-4 flex justify-between items-center bg-white/5 border-b border-[#00FFFF]/10 group">
          <div className="flex items-center gap-3">
            <span className="text-[10px] font-black tracking-[0.2em] text-[#00FFFF] uppercase">
              {title}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => setIsCollapsed(!isCollapsed)} className="text-[#00FFFF]/40 hover:text-[#00FFFF] transition-colors">
              {isCollapsed ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
            </button>
            <button 
              onClick={() => setIsDocked(false)}
              className="text-[#00FFFF]/60 hover:text-[#00FFFF] transition-colors text-[10px] uppercase font-bold tracking-widest px-2"
              title="Pop out"
            >
              Pop Out
            </button>
            {onClose && (
              <button onClick={onClose} className="text-white/20 hover:text-[#FF5F1F] transition-colors p-1">
                <X size={16} />
              </button>
            )}
          </div>
        </div>
        {!isCollapsed && (
          <div className="flex-1 overflow-hidden relative">
            {children}
          </div>
        )}
      </div>
    );
  }

  return (
    <motion.div
      ref={containerRef}
      drag={!isCollapsed}
      dragMomentum={false}
      dragListener={!isResizing && !isCollapsed}
      initial={{ opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: 1, height: isCollapsed ? 40 : size.height }}
      style={{
        width: size.width,
        position: 'absolute',
        top: defaultPosition.y,
        left: defaultPosition.x,
        zIndex: 100,
      }}
      className={`glass-panel p-0 flex flex-col overflow-hidden pointer-events-auto border-[#00FFFF]/20 shadow-[0_0_40px_rgba(0,0,0,0.5)] ${className} ${isCollapsed ? 'border-b-0' : ''}`}
      id={id}
    >
      {/* Drag & Header Handle */}
      <div className="h-10 px-4 flex justify-between items-center bg-white/5 border-b border-[#00FFFF]/10 cursor-grab active:cursor-grabbing select-none group">
        <div className="flex items-center gap-3">
          <GripHorizontal size={14} className="text-[#00FFFF]/40 group-hover:text-[#00FFFF] transition-colors" />
          <span className="text-[10px] font-black tracking-[0.2em] text-[#00FFFF]/60 uppercase">
            {title}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button 
            onClick={() => setIsMinimized(true)}
            className="text-white/20 hover:text-[#00FFFF] transition-colors p-1"
            title="Minimize"
          >
            <Minus size={14} />
          </button>
          <button 
            onClick={() => setIsCollapsed(!isCollapsed)}
            className="text-white/20 hover:text-[#00FFFF] transition-colors p-1"
            title={isCollapsed ? "Expand" : "Collapse"}
          >
            {isCollapsed ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
          </button>
          {dockable && (
            <button 
              onClick={() => setIsDocked(true)}
              className="text-[#00FFFF]/60 hover:text-[#00FFFF] transition-colors text-[10px] uppercase font-bold tracking-widest px-2"
              title="Dock to side"
            >
              Dock
            </button>
          )}
          {onClose && (
            <button 
              onClick={onClose}
              className="text-white/20 hover:text-[#FF5F1F] transition-colors p-1"
            >
              <X size={16} />
            </button>
          )}
        </div>
      </div>

      {/* Pane Content */}
      <AnimatePresence>
        {!isCollapsed && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="flex-1 overflow-hidden relative"
          >
            {children}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Resize Handle (Bottom-Right) */}
      {!isCollapsed && (
        <div 
          onMouseDown={handleResizeStart}
          className="absolute bottom-0 right-0 w-6 h-6 cursor-nwse-resize group/resize z-[110]"
        >
          <div className="absolute bottom-1 right-1 w-3 h-3 border-r-2 border-b-2 border-[#00FFFF]/20 group-hover/resize:border-[#00FFFF] transition-colors" />
        </div>
      )}
    </motion.div>
  );
}
