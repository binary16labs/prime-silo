import React, { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Line } from '@react-three/drei';
import * as THREE from 'three';

interface Props {
  cycles: string[][];
  livePositions: React.MutableRefObject<Map<string, THREE.Vector3>>;
  enabled: boolean;
}

export function CycleOverlay({ cycles, livePositions, enabled }: Props) {
  const lineRefs = useRef<Array<any>>([]);
  const pointsCache = useMemo(
    () => cycles.map(() => [new THREE.Vector3(), new THREE.Vector3()]),
    [cycles]
  );

  useFrame(({ clock }) => {
    if (!enabled) return;
    const pulse = 0.5 + 0.5 * Math.sin(clock.elapsedTime * 1.8);
    cycles.forEach((cycle, i) => {
      const lineRef = lineRefs.current[i];
      if (!lineRef || !lineRef.geometry) return;
      const positions: number[] = [];
      for (let j = 0; j < cycle.length; j++) {
        const p = livePositions.current.get(cycle[j]);
        if (p) positions.push(p.x, p.y, p.z);
      }
      if (positions.length >= 6) {
        positions.push(positions[0], positions[1], positions[2]);
        try {
          lineRef.geometry.setPositions(positions);
          lineRef.computeLineDistances?.();
        } catch { /* ref not ready */ }
      }
      const mat = lineRef.material;
      if (mat) mat.opacity = 0.25 + 0.5 * pulse;
    });
  });

  if (!enabled || cycles.length === 0) return null;

  return (
    <group>
      {cycles.map((_, i) => (
        <Line
          key={i}
          ref={(r: any) => { lineRefs.current[i] = r; }}
          points={pointsCache[i]}
          color="#FF00FF"
          lineWidth={2.5}
          transparent
          opacity={0.6}
          dashed={false}
        />
      ))}
    </group>
  );
}
