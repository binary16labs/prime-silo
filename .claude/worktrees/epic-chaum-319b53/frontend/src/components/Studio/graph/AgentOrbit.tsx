import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import * as THREE from 'three';

interface Props {
  selectedPos: THREE.Vector3 | null;
  enabled: boolean;
}

const AGENTS = [
  { id: 'planner',  label: 'PLAN',  color: '#00FFFF' },
  { id: 'critic',   label: 'CRIT',  color: '#FF00FF' },
  { id: 'builder',  label: 'BUILD', color: '#39FF14' },
];

export function AgentOrbit({ selectedPos, enabled }: Props) {
  const groupRef = useRef<THREE.Group>(null);

  useFrame(({ clock }) => {
    if (!enabled || !selectedPos || !groupRef.current) return;
    groupRef.current.position.copy(selectedPos);
    groupRef.current.rotation.y = clock.elapsedTime * 0.4;
  });

  if (!enabled || !selectedPos) return null;

  return (
    <group ref={groupRef}>
      {AGENTS.map((a, i) => {
        const angle = (i / AGENTS.length) * Math.PI * 2;
        const r = 2.8;
        return (
          <group key={a.id} position={[Math.cos(angle) * r, 0, Math.sin(angle) * r]}>
            <mesh>
              <sphereGeometry args={[0.18, 12, 12]} />
              <meshBasicMaterial color={a.color} transparent opacity={0.9} />
            </mesh>
            <Html center distanceFactor={14}>
              <div className="pointer-events-none select-none">
                <div
                  className="px-1.5 py-0.5 rounded bg-black/70 border border-white/20 text-[7px] font-black font-mono tracking-widest uppercase"
                  style={{ color: a.color }}
                >
                  {a.label}
                </div>
              </div>
            </Html>
          </group>
        );
      })}
    </group>
  );
}
