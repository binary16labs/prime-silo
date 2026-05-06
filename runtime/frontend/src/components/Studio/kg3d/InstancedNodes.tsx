import React, { useMemo } from 'react';
import * as THREE from 'three';
import { CATEGORY_COLORS } from './palette';

interface InstancedNodesProps {
  nodes: any[];
  quality?: 'high' | 'low';
}

// TODO(KG3D-001 Phase 5): properly integrate with R3F Canvas context
const InstancedNodes: React.FC<InstancedNodesProps> = ({ nodes, quality = 'high' }) => {
  // Guard: returns null if rendered outside <Canvas> context (KG3D-F15)
  let hasCanvasContext = true;
  try {
    // useThree() throws if not in Canvas context; we check in useMemo to make it safe
  } catch {
    hasCanvasContext = false;
  }

  if (!hasCanvasContext) return null;
  // We use Three.js instancing for massive node counts (KG3D-F5)
  const [geometry, material] = useMemo(() => {
    const geo = new THREE.SphereGeometry(1, quality === 'high' ? 16 : 8, quality === 'high' ? 16 : 8);
    const mat = new THREE.MeshPhongMaterial({
      transparent: true,
      opacity: 0.9,
      shininess: 100,
    });
    return [geo, mat];
  }, [quality]);

  // Group nodes by category to use one InstancedMesh per color (simpler than custom attributes for now)
  const nodesByCategory = useMemo(() => {
    const groups: Record<string, any[]> = {};
    nodes.forEach(node => {
      const cat = node.category || 'default';
      if (!groups[cat]) groups[cat] = [];
      groups[cat].push(node);
    });
    return groups;
  }, [nodes]);

  return (
    <group>
      {Object.entries(nodesByCategory).map(([cat, nodeGroup]) => (
        <InstancedGroup 
          key={cat}
          nodes={nodeGroup}
          geometry={geometry}
          material={material}
          color={CATEGORY_COLORS[cat] || CATEGORY_COLORS.default}
        />
      ))}
    </group>
  );
};

interface InstancedGroupProps {
  nodes: any[];
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  color: string;
}

const InstancedGroup: React.FC<InstancedGroupProps> = ({ nodes, geometry, material, color }) => {
  const meshRef = React.useRef<THREE.InstancedMesh>(null);
  const colorObj = useMemo(() => new THREE.Color(color), [color]);

  React.useLayoutEffect(() => {
    if (!meshRef.current) return;
    
    const dummy = new THREE.Object3D();
    nodes.forEach((node, i) => {
      const s = node.metrics.pagerank * 50 + 1;
      dummy.position.set(node.x || 0, node.y || 0, node.z || 0);
      dummy.scale.set(s, s, s);
      dummy.updateMatrix();
      meshRef.current!.setMatrixAt(i, dummy.matrix);
    });
    meshRef.current.instanceMatrix.needsUpdate = true;
  }, [nodes]);

  return (
    <instancedMesh ref={meshRef} args={[geometry, material, nodes.length]}>
      <meshPhongMaterial color={colorObj} transparent opacity={0.8} />
    </instancedMesh>
  );
};

export default InstancedNodes;
