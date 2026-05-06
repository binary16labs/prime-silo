import { useEffect, useRef, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';

export type ZoomTier = 'macro' | 'meso' | 'micro';

// Thresholds tuned against default camera start [0, 40, 80] (distance ~89).
const MACRO_MIN = 90;    // above this = macro
const MESO_MIN = 40;     // between this and MACRO_MIN = meso
// below MESO_MIN = micro

export function useSemanticZoom(enabled: boolean): { tier: ZoomTier; distance: number } {
  const { camera } = useThree();
  const [tier, setTier] = useState<ZoomTier>('macro');
  const [distance, setDistance] = useState(90);
  const lastTier = useRef<ZoomTier>('macro');
  const throttle = useRef(0);

  useFrame(() => {
    if (!enabled) return;
    const now = performance.now();
    if (now - throttle.current < 100) return;
    throttle.current = now;
    const d = camera.position.length();
    setDistance(d);
    const next: ZoomTier = d >= MACRO_MIN ? 'macro' : d >= MESO_MIN ? 'meso' : 'micro';
    if (next !== lastTier.current) {
      lastTier.current = next;
      setTier(next);
    }
  });

  useEffect(() => {
    if (!enabled) setTier('macro');
  }, [enabled]);

  return { tier, distance };
}
