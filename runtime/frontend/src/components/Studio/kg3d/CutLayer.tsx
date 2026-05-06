import React, { useMemo } from 'react';
import * as THREE from 'three';

interface CutLayerProps {
  layer: number;
  height: number;
  width: number;
  depth: number;
}

/**
 * AoT Cut Layer (KG3D-F6)
 * Renders a translucent horizontal plane to separate abstract and specific layers.
 */
const CutLayer: React.FC<CutLayerProps> = ({ layer, height, width, depth }) => {
  const [geometry, material] = useMemo(() => {
    const geo = new THREE.PlaneGeometry(width * 2, depth * 2);
    const mat = new THREE.MeshPhongMaterial({
      color: "#00FFFF",
      transparent: true,
      opacity: 0.05,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
    return [geo, mat];
  }, [width, depth]);

  return (
    <group rotation={[-Math.PI / 2, 0, 0]} position={[0, height, 0]}>
      <mesh geometry={geometry} material={material} />
      {/* Add a glowing border for the layer */}
      <lineSegments>
        <edgesGeometry args={[geometry]} />
        <lineBasicMaterial color="#00FFFF" transparent opacity={0.2} />
      </lineSegments>
    </group>
  );
};

export default CutLayer;
