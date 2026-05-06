import { useRef, useMemo, useState, useEffect } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls, Stars, Text, Sphere, Line } from '@react-three/drei';
import * as THREE from 'three';
import { useWorkspaceStore } from '../../hooks/useWorkspaceStore';
import { API_BASE_URL, GOVERNANCE_HEADERS } from '../../constants';

// --- Synoptic Memory Node ---
function SynopticNode({ position, label, color, importance }: { position: [number, number, number], label: string, color: string, importance: number }) {
  const ref = useRef<THREE.Mesh>(null);
  const size = 0.2 + importance * 0.4;

  useFrame((state) => {
    if (ref.current) {
      ref.current.position.y = position[1] + Math.sin(state.clock.elapsedTime * 2 + position[0]) * 0.1;
      ref.current.rotation.y += 0.01;
    }
  });

  return (
    <group position={position}>
      <Sphere ref={ref} args={[size, 16, 16]}>
        <meshBasicMaterial color={color} transparent opacity={0.8} toneMapped={false} />
      </Sphere>
      <Sphere args={[size * 1.5, 8, 8]}>
        <meshBasicMaterial color={color} wireframe transparent opacity={0.1} toneMapped={false} />
      </Sphere>
      <Text 
        position={[0, size + 0.4, 0]} 
        fontSize={0.2} 
        color={color} 
        anchorX="center" 
        anchorY="middle"
      >
        {label}
      </Text>
    </group>
  );
}

export function SynopticWeb() {
  const { currentWorkspace, activeGraphId } = useWorkspaceStore();
  const [graphData, setGraphData] = useState<{ nodes: any[], edges: any[] }>({ nodes: [], edges: [] });
  const [loading, setLoading] = useState(false);

  const fetchGraph = async () => {
    setLoading(true);
    try {
      const runParam = activeGraphId && activeGraphId !== 'neural_nexus' ? `&run_id=${activeGraphId}` : '';
      const response = await fetch(`${API_BASE_URL}/api/graph/full?workspace=${currentWorkspace}${runParam}`, {
        headers: { ...GOVERNANCE_HEADERS }
      });
      if (response.ok) {
        const data = await response.json();
        setGraphData(data);
      }
    } catch (err) {
      console.error('Failed to fetch synoptic graph:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchGraph();
  }, [currentWorkspace, activeGraphId]);

  // Layout concepts in a 3D sphere/cloud
  const processedNodes = useMemo(() => {
    return graphData.nodes.map((node, i) => {
      const phi = Math.acos(-1 + (2 * i) / graphData.nodes.length);
      const theta = Math.sqrt(graphData.nodes.length * Math.PI) * phi;
      const radius = 15;
      
      return {
        ...node,
        pos: [
          radius * Math.cos(theta) * Math.sin(phi),
          radius * Math.sin(theta) * Math.sin(phi),
          radius * Math.cos(phi)
        ] as [number, number, number]
      };
    });
  }, [graphData.nodes]);

  const processedEdges = useMemo(() => {
    return graphData.edges.map(edge => {
      const startNode = processedNodes.find(n => n.id === edge.source);
      const endNode = processedNodes.find(n => n.id === edge.target);
      return {
        ...edge,
        start: startNode?.pos || [0,0,0],
        end: endNode?.pos || [0,0,0]
      };
    });
  }, [graphData.edges, processedNodes]);

  return (
    <div className="absolute inset-0 bg-[#020408]">
      <Canvas camera={{ position: [0, 20, 40], fov: 60 }}>
        <color attach="background" args={['#020408']} />
        <ambientLight intensity={0.4} />
        <Stars radius={100} depth={50} count={5000} factor={4} saturation={1} fade speed={0.5} />
        
        <group>
          {processedNodes.map(concept => (
            <SynopticNode 
              key={concept.id}
              position={concept.pos}
              label={concept.name}
              color={concept.node_type === 'Source' ? '#4dbbff' : '#a78bfa'}
              importance={concept.centrality ? concept.centrality / 10 : 0.5}
            />
          ))}

          {processedEdges.map((edge, i) => (
            <Line 
              key={i}
              points={[edge.start, edge.end]} 
              color="#00FFFF" 
              transparent 
              opacity={0.3} 
              lineWidth={1}
            />
          ))}
        </group>

        <OrbitControls autoRotate autoRotateSpeed={0.2} />
      </Canvas>

      <div className="absolute top-10 left-10 pointer-events-none">
        <h1 className="glow-text-cyan text-[24px] font-bold tracking-widest uppercase">Synoptic_Web</h1>
        <div className="text-[10px] text-white/40 font-mono tracking-widest mt-2">
            ACTIVE_WORKSPACE: {currentWorkspace?.toUpperCase() || 'DEFAULT'}
            {activeGraphId && activeGraphId !== 'neural_nexus' && ` | SNAPSHOT: ${activeGraphId.substring(0,8)}`}
        </div>
      </div>
      
      {loading && (
        <div className="absolute bottom-10 left-1/2 -translate-x-1/2 text-[10px] text-[#00FFFF] font-black tracking-widest animate-pulse">
          SYNCHRONIZING_NEURAL_MAP...
        </div>
      )}
    </div>
  );
}
