import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

interface NebulaProps {
  centroids: Map<number, [number, number, number]>;
  density: number;          // 0..3
  enabled: boolean;
  rotate: boolean;          // cluster rotation toggle
}

// One nebula per community — gaussian-ish blob of additive points.
export function NeuralNebula({ centroids, density, enabled, rotate }: NebulaProps) {
  const groupRef = useRef<THREE.Group>(null);

  const blobs = useMemo(() => {
    if (!enabled) return [];
    const out: Array<{ id: number; positions: Float32Array; color: THREE.Color }> = [];
    centroids.forEach((center, id) => {
      const count = Math.max(24, Math.round(120 * density));
      const positions = new Float32Array(count * 3);
      const radius = 6;
      for (let i = 0; i < count; i++) {
        const r = radius * Math.pow(Math.random(), 0.5);
        const theta = Math.random() * Math.PI * 2;
        const phi = Math.acos(2 * Math.random() - 1);
        positions[i * 3]     = center[0] + r * Math.sin(phi) * Math.cos(theta);
        positions[i * 3 + 1] = center[1] + r * Math.sin(phi) * Math.sin(theta);
        positions[i * 3 + 2] = center[2] + r * Math.cos(phi);
      }
      const color = new THREE.Color(`hsl(${(id * 137.5) % 360}, 70%, 60%)`);
      out.push({ id, positions, color });
    });
    return out;
  }, [centroids, density, enabled]);

  useFrame((_, delta) => {
    if (!rotate || !groupRef.current) return;
    groupRef.current.rotation.y += delta * 0.04;
  });

  if (!enabled || blobs.length === 0) return null;

  return (
    <group ref={groupRef}>
      {blobs.map(blob => (
        <points key={blob.id}>
          <bufferGeometry>
            <bufferAttribute
              attach="attributes-position"
              args={[blob.positions, 3]}
              count={blob.positions.length / 3}
            />
          </bufferGeometry>
          <pointsMaterial
            size={0.25}
            color={blob.color}
            transparent
            opacity={0.35}
            sizeAttenuation
            depthWrite={false}
            blending={THREE.AdditiveBlending}
          />
        </points>
      ))}
    </group>
  );
}
