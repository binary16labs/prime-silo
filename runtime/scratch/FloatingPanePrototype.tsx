import React, { useState, useRef } from 'react';
import { motion } from 'framer-motion';

export function FloatingPane({ children, title, defaultPos = { x: 0, y: 0 }, defaultSize = { w: 400, h: 300 }, onClose }: any) {
  const [size, setSize] = useState(defaultSize);
  const isResizing = useRef(false);

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    isResizing.current = true;
    const startX = e.clientX;
    const startY = e.clientY;
    const startW = size.w;
    const startH = size.h;

    const onMouseMove = (moveEvent: MouseEvent) => {
      if (!isResizing.current) return;
      const newW = Math.max(200, startW + (moveEvent.clientX - startX));
      const newH = Math.max(100, startH + (moveEvent.clientY - startY));
      setSize({ w: newW, h: newH });
    };

    const onMouseUp = () => {
      isResizing.current = false;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  };

  return (
    <motion.div
      drag
      dragMomentum={false}
      initial={{ ...defaultPos, opacity: 0 }}
      animate={{ opacity: 1 }}
      style={{
        position: 'absolute',
        width: size.w,
        height: size.h,
        zIndex: 100,
      }}
      className="glass-panel p-0 overflow-hidden flex flex-col pointer-events-auto"
    >
      {/* Drag Handle (Header) */}
      <div className="p-3 bg-white/5 cursor-grab active:cursor-grabbing border-b border-[#00FFFF]/10 flex justify-between items-center h-10 select-none">
        <span className="text-[10px] font-black tracking-widest text-[#00FFFF]/60">{title}</span>
        {onClose && <button onClick={onClose} className="text-white/30 hover:text-white">✕</button>}
      </div>
      
      {/* Content */}
      <div className="flex-1 overflow-hidden">
        {children}
      </div>

      {/* Resize Handle */}
      <div 
        onMouseDown={startResize}
        className="absolute bottom-0 right-0 w-4 h-4 cursor-nwse-resize bg-gradient-to-br from-transparent to-[#00FFFF]/30 hover:to-[#00FFFF] transition-all"
        style={{ clipPath: 'polygon(100% 0, 0 100%, 100% 100%)' }}
      />
    </motion.div>
  );
}
