import React, { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

export interface FlowEdge {
  source: string;
  target: string;
  type: string;
  importance: number; // 0..1
}

interface Props {
  edges: FlowEdge[];
  livePositions: React.MutableRefObject<Map<string, THREE.Vector3>>;
  density: number;   // 0..3 multiplier
  pulseEdgeKeys: Set<string>; // edges currently pulsing from execution events
}

const EDGE_COLORS: Record<string, string> = {
  INHERITS: '#39FF14',
  DEFINES: '#ffffff',
  CALLS: '#FF5F1F',
  DEPENDS_ON: '#00FFFF',
  CONTAINS: '#a78bfa',
  REL: '#FF00FF',
};

// A single InstancedMesh of small spheres representing packets traveling
// along edges, position = lerp(src, tgt, t) with t = (time*speed + offset) % 1.
export function DataFlowParticles({ edges, livePositions, density, pulseEdgeKeys }: Props) {
  // Determine per-edge particle count from importance × density.
  const plan = useMemo(() => {
    const plan: Array<{ key: string; src: string; tgt: string; color: THREE.Color; speed: number; offset: number }> = [];
    for (const e of edges) {
      const baseCount = e.importance > 0.6 ? 3 : e.importance > 0.3 ? 2 : 1;
      const count = Math.max(0, Math.round(baseCount * density));
      if (count === 0) continue;
      const color = new THREE.Color(EDGE_COLORS[e.type] || '#888888');
      const key = `${e.source}->${e.target}:${e.type}`;
      for (let i = 0; i < count; i++) {
        plan.push({
          key,
          src: e.source,
          tgt: e.target,
          color,
          speed: 0.25 + e.importance * 0.6 + Math.random() * 0.15,
          offset: i / count + Math.random() * 0.04,
        });
      }
    }
    return plan;
  }, [edges, density]);

  const count = plan.length;
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const colorArr = useMemo(() => new Float32Array(count * 3), [count]);

  useFrame(({ clock }) => {
    if (!meshRef.current || count === 0) return;
    const t = clock.elapsedTime;

    for (let i = 0; i < count; i++) {
      const p = plan[i];
      const src = livePositions.current.get(p.src);
      const tgt = livePositions.current.get(p.tgt);
      if (!src || !tgt) {
        dummy.position.set(0, -9999, 0);
        dummy.scale.setScalar(0);
        dummy.updateMatrix();
        meshRef.current.setMatrixAt(i, dummy.matrix);
        continue;
      }
      const phase = (t * p.speed + p.offset) % 1;
      dummy.position.lerpVectors(src, tgt, phase);
      const pulsing = pulseEdgeKeys.has(p.key);
      const scale = pulsing ? 0.22 : 0.11;
      dummy.scale.setScalar(scale);
      dummy.updateMatrix();
      meshRef.current.setMatrixAt(i, dummy.matrix);

      const boost = pulsing ? 1.6 : 1.0;
      colorArr[i * 3] = p.color.r * boost;
      colorArr[i * 3 + 1] = p.color.g * boost;
      colorArr[i * 3 + 2] = p.color.b * boost;
    }
    meshRef.current.instanceMatrix.needsUpdate = true;
    if (meshRef.current.instanceColor) {
      meshRef.current.instanceColor.array = colorArr;
      meshRef.current.instanceColor.needsUpdate = true;
    } else {
      meshRef.current.instanceColor = new THREE.InstancedBufferAttribute(colorArr, 3);
    }
  });

  if (count === 0) return null;

  return (
    <instancedMesh
      ref={meshRef}
      args={[undefined, undefined, count]}
      frustumCulled={false}
    >
      <sphereGeometry args={[1, 6, 6]} />
      <meshBasicMaterial vertexColors transparent opacity={0.9} blending={THREE.AdditiveBlending} depthWrite={false} />
    </instancedMesh>
  );
}
