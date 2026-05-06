import React, { useRef, useMemo, useState, useEffect } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import {
  OrbitControls,
  Stars,
  Line,
  Html,
  CameraControls,
  KeyboardControls,
  useKeyboardControls
} from '@react-three/drei';
import * as THREE from 'three';
import { motion, AnimatePresence } from 'framer-motion';
import { useWorkflowStore } from '../../hooks/useWorkflowStore';
import { useWorkspaceStore } from '../../hooks/useWorkspaceStore';
import { API_BASE_URL, GOVERNANCE_HEADERS } from '../../constants';
import {
  Folder as FolderIcon,
  Play,
  RefreshCw,
  Layers,
  Terminal,
  ChevronRight,
  Home,
  Settings,
  Link2
} from 'lucide-react';
import { SymbolInspector } from './SymbolInspector';
import { analyzeMesh, edgeKey as meshEdgeKey } from './graph/CognitiveMeshEngine';
import type { MeshAnalysis } from './graph/CognitiveMeshEngine';
import { Sonification } from './graph/SonificationEngine';
import { useSemanticZoom } from './graph/useSemanticZoom';
import type { ZoomTier } from './graph/useSemanticZoom';
import { DataFlowParticles } from './graph/DataFlowParticles';
import { NeuralNebula } from './graph/NeuralNebula';
import { CycleOverlay } from './graph/CycleOverlay';
import { AgentOrbit } from './graph/AgentOrbit';
import { AgenticPanel } from './graph/AgenticPanel';
import { TimeTravelScrubber } from './graph/TimeTravelScrubber';
import { useBlastRadius, blastOpacity, blastColorTint } from './graph/BlastRadiusHighlight';

type CogMesh = {
  semanticZoom: boolean;
  degreeSizing: boolean;
  myelination: boolean;
  synapticPruning: boolean;
  blastRadius: boolean;
  dataFlowParticles: boolean;
  cycleDetection: boolean;
  neuralNebula: boolean;
  clusterRotation: boolean;
  agentOrbit: boolean;
  agenticPanels: boolean;
  timeTravelOpen: boolean;
  sonification: boolean;
  ambientHeartbeat: boolean;
  foveatedLOD: boolean;
  knowledgeEnrichment: boolean;
  bloomIntensity: number;
  pruneThreshold: number;
  particleDensity: number;
  timeScrubIndex: number;
  timeCompression: number;
};

// --- Visual Components ---

interface CodeNodeProps {
  id: string;
  position: [number, number, number];
  livePositions: React.MutableRefObject<Map<string, THREE.Vector3>>;
  name: string;
  type: string;
  isSelected: boolean;
  isClusterMode: boolean;
  enableNodeRotation?: boolean;
  metadata?: any;
  scale?: number;
  onClick: () => void;
  // Cognitive Mesh additions
  cognitiveMesh?: CogMesh;
  degree?: number;
  maxDegree?: number;
  zoomTier?: ZoomTier;
  inDownstream?: boolean;
  inUpstream?: boolean;
  hasBlastSelection?: boolean;
}

function FloatingMetadataHUD({ metadata, hovered }: { metadata: any, hovered: boolean }) {
  if (!hovered || !metadata) return null;

  const entries = Object.entries(metadata).filter(([_, v]) => v && typeof v !== 'object').slice(0, 4);

  return (
    <group>
      {entries.map(([key, value], i) => {
        const angle = (i / entries.length) * Math.PI * 2;
        const radius = 1.2;
        return (
          <Html key={key} position={[Math.cos(angle) * radius, Math.sin(angle) * radius, 0]} center>
            <motion.div 
              initial={{ scale: 0, opacity: 0, y: 0 }}
              animate={{ scale: 1, opacity: 1, y: -20 }}
              className="px-2 py-1 rounded-sm bg-[#00FFFF]/10 border border-[#00FFFF]/30 backdrop-blur-md"
            >
              <div className="text-[6px] text-[#00FFFF]/60 uppercase font-black tracking-tighter">{key}</div>
              <div className="text-[8px] text-white font-mono whitespace-nowrap">{String(value)}</div>
            </motion.div>
          </Html>
        );
      })}
    </group>
  );
}

function NeuralSpark({ node, active }: { node: any, active: boolean }) {
  const groupRef = useRef<THREE.Group>(null);
  
  useFrame(() => {
    if (groupRef.current && active) {
      groupRef.current.rotation.y += 0.02;
      groupRef.current.rotation.x += 0.01;
    }
  });

  if (!active || !node.metadata) return null;

  // Projection of labels or related concepts as orbiting satellites
  const satList = [
    { label: node.type, color: "#00FFFF" },
    { label: node.metadata?.community_name || 'Neural Nexus', color: "#FF00FF" },
    { label: node.metadata?.strategy || 'safe', color: "#39FF14" }
  ].filter(s => s.label);

  return (
    <group ref={groupRef}>
      {satList.map((sat, i) => {
        const phi = Math.acos(-1 + (2 * i) / satList.length);
        const theta = Math.sqrt(satList.length * Math.PI) * phi;
        const radius = 1.5;
        
        return (
          <group 
            key={i} 
            position={[
              radius * Math.cos(theta) * Math.sin(phi),
              radius * Math.sin(theta) * Math.sin(phi),
              radius * Math.cos(phi)
            ]}
          >
            <Html center>
              <motion.div 
                initial={{ opacity: 0, scale: 0 }}
                animate={{ opacity: 1, scale: 1 }}
                className="pointer-events-none select-none"
              >
                <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-black/60 border border-white/20 backdrop-blur-md">
                   <div className="w-1 h-1 rounded-full animate-pulse" style={{ backgroundColor: sat.color }} />
                   <span className="text-[7px] text-white/80 font-mono uppercase tracking-widest">{sat.label}</span>
                </div>
              </motion.div>
            </Html>
          </group>
        );
      })}
      
      {/* Orbital Ring */}
      <mesh rotation={[Math.PI / 2, 0, 0]}>
        <ringGeometry args={[1.4, 1.42, 64]} />
        <meshBasicMaterial color="#00FFFF" transparent opacity={0.1} side={THREE.DoubleSide} />
      </mesh>
    </group>
  );
}

function CodeSymbolNode({
  id, position, livePositions, name, type,
  isSelected, isClusterMode, enableNodeRotation, metadata, scale = 1, onClick,
  cognitiveMesh, degree = 0, maxDegree = 1, zoomTier = 'macro',
  inDownstream = false, inUpstream = false, hasBlastSelection = false,
}: CodeNodeProps) {
  const groupRef = useRef<THREE.Group>(null);
  const meshRef = useRef<THREE.Mesh>(null);
  const [hovered, setHovered] = useState(false);
  const [farLOD, setFarLOD] = useState(false);
  const lastLODSwap = useRef(0);

  useEffect(() => {
    document.body.style.cursor = hovered ? 'pointer' : 'auto';
    return () => { document.body.style.cursor = 'auto'; };
  }, [hovered]);

  const degreeRatio = Math.min(1, degree / Math.max(1, maxDegree));
  const degreeBoost = cognitiveMesh?.degreeSizing ? 1 + 1.0 * degreeRatio : 1;
  const isPruned = !!(cognitiveMesh?.synapticPruning && degreeRatio < (cognitiveMesh?.pruneThreshold ?? 0.2) && !isSelected);

  useFrame(({ camera }) => {
    const nodeLivePos = livePositions.current.get(String(id));
    if (groupRef.current) {
      if (nodeLivePos) {
        groupRef.current.position.copy(nodeLivePos);
      } else {
        groupRef.current.position.set(position[0], position[1], position[2]);
      }
      // Foveated LOD — hysteretic swap so we don't flicker
      if (cognitiveMesh?.foveatedLOD) {
        const d = camera.position.distanceTo(groupRef.current.position);
        const now = performance.now();
        if (now - lastLODSwap.current > 250) {
          if (!farLOD && d > 75) { setFarLOD(true); lastLODSwap.current = now; }
          else if (farLOD && d < 65) { setFarLOD(false); lastLODSwap.current = now; }
        }
      } else if (farLOD) {
        setFarLOD(false);
      }
    }

    if (meshRef.current) {
      if (enableNodeRotation) {
        meshRef.current.rotation.y += 0.01;
      }
      const target = (isSelected || hovered) ? 1.8 * degreeBoost : degreeBoost;
      meshRef.current.scale.lerp(new THREE.Vector3(target, target, target), 0.1);
    }
  });

  const getGeometry = () => {
    if (farLOD) return <sphereGeometry args={[0.35 * scale, 6, 6]} />;
    const s = scale;
    switch (type) {
      case 'Folder':        return <boxGeometry args={[0.7 * s, 0.7 * s, 0.7 * s]} />;
      case 'File':          return <octahedronGeometry args={[0.5 * s, 0]} />;
      case 'Documentation': return <octahedronGeometry args={[0.6 * s, 0]} />;
      case 'Class':         return <boxGeometry args={[0.6 * s, 0.6 * s, 0.6 * s]} />;
      case 'Interface':     return <boxGeometry args={[0.5 * s, 0.5 * s, 0.5 * s]} />;
      case 'Function':      return <sphereGeometry args={[0.3 * s, 16, 16]} />;
      case 'Concept':       return <sphereGeometry args={[0.4 * s, 24, 24]} />;
      case 'Import':        return <octahedronGeometry args={[0.25 * s, 0]} />;
      case 'ExternalClass': return <octahedronGeometry args={[0.45 * s, 1]} />;
      default:              return <sphereGeometry args={[0.2 * s, 8, 8]} />;
    }
  };

  const getColor = () => {
    if (isSelected) return "#FFFFFF";
    if (hovered) return "#00FFFF";
    switch (type) {
      case 'Folder': return "#FFD700"; // Gold for Folders
      case 'File': return "#00FFFF";
      case 'Class': return "#007ACC";
      case 'Interface': return "#39FF14";
      case 'Function': return "#FF5F1F";
      case 'Documentation': return "#00FFFF";
      case 'Concept': return "#FF00FF";
      case 'Import': return "#00BFFF";       // Deep sky blue — DEPENDS_ON targets
      case 'ExternalClass': return "#AAFFAA"; // Ghost green — INHERITS targets
      default: return "#888888";
    }
  };

  const getNodeColor = () => {
    // If community_id is present and we are in cluster mode (conceptual), use HSL
    if (isClusterMode && metadata?.community_id !== undefined) {
      const cId = Number(metadata.community_id);
      if (!isNaN(cId)) {
        return `hsl(${(cId * 137.5) % 360}, 70%, 60%)`;
      }
    }
    return getColor();
  };

  const baseColor = getNodeColor();
  const tintedColor = blastColorTint(inDownstream, inUpstream, baseColor);
  const baseOpacity = blastOpacity(isSelected, inDownstream, inUpstream, hasBlastSelection, 0.9);
  const finalOpacity = isPruned ? baseOpacity * 0.2 : baseOpacity;
  const emissiveBoost = (cognitiveMesh?.bloomIntensity ?? 1);
  const emissiveIntensity = (isSelected || hovered ? 2 : 0.5) * emissiveBoost * (isPruned ? 0.3 : 1);

  // Semantic-zoom driven label visibility
  const showLabelAlways = zoomTier === 'meso' || zoomTier === 'micro';
  const showSatellites = zoomTier === 'micro' || isSelected || hovered;

  return (
    <group
      ref={groupRef}
      onPointerOver={(e) => {
        e.stopPropagation();
        setHovered(true);
        if (cognitiveMesh?.sonification) Sonification.emit('hover', { nodeType: type });
      }}
      onPointerOut={() => setHovered(false)}
    >
      <mesh
        ref={meshRef}
        onClick={(e) => {
          e.stopPropagation();
          if (cognitiveMesh?.sonification) Sonification.emit('click', { nodeType: type });
          onClick();
        }}
      >
        {getGeometry()}
        <meshStandardMaterial
          color={tintedColor}
          emissive={tintedColor}
          emissiveIntensity={emissiveIntensity}
          transparent
          opacity={finalOpacity}
        />
      </mesh>

      {showSatellites && <NeuralSpark node={{ id, name, type, metadata }} active={isSelected || hovered} />}
      {(zoomTier === 'micro' || hovered) && <FloatingMetadataHUD metadata={metadata} hovered={hovered || zoomTier === 'micro'} />}

      <Html distanceFactor={15} position={[0, -0.8, 0]} center>
        <div className={`whitespace-nowrap px-2 py-1 rounded bg-black/80 border border-white/10 text-[8px] font-mono text-white pointer-events-none transition-all duration-300 ${isSelected || hovered ? 'opacity-100 scale-110 border-[#00FFFF]/40 shadow-[0_0_10px_rgba(0,255,255,0.2)]' : showLabelAlways ? 'opacity-80' : 'opacity-40'}`}>
          {name}
        </div>
      </Html>
    </group>
  );
}

// --- Interactive Edge Component ---

function CodeGraphEdge({
  edge, livePositions, isSelected, isNodeSelected, onClick,
  cognitiveMesh, importance = 0, inDownstream = false, inUpstream = false, hasBlastSelection = false,
}: {
  edge: any;
  livePositions: React.MutableRefObject<Map<string, THREE.Vector3>>;
  isSelected: boolean;
  isNodeSelected: boolean;
  onClick: () => void;
  cognitiveMesh?: CogMesh;
  importance?: number;
  inDownstream?: boolean;
  inUpstream?: boolean;
  hasBlastSelection?: boolean;
}) {
  const [hovered, setHovered] = useState(false);
  const lineRef = useRef<any>(null);
  const arrowRef = useRef<THREE.Mesh>(null);
  const hitMeshRef = useRef<THREE.Mesh>(null);
  
  useEffect(() => {
    if (hovered) document.body.style.cursor = 'pointer';
    return () => { document.body.style.cursor = 'auto'; };
  }, [hovered]);

  useFrame(() => {
    const start = livePositions.current.get(String(edge.source));
    const end = livePositions.current.get(String(edge.target));

    if (start && end) {
      // Update Line (Drei Line ref is a Line2 instance)
      if (lineRef.current && lineRef.current.geometry) {
        lineRef.current.geometry.setPositions([
          start.x, start.y, start.z,
          end.x, end.y, end.z
        ]);
        lineRef.current.computeLineDistances();
      }

      // Update Hitbox and Midpoint components
      const midpoint = start.clone().add(end).multiplyScalar(0.5);
      const distance = start.distanceTo(end);
      
      if (hitMeshRef.current) {
        hitMeshRef.current.position.copy(midpoint);
        hitMeshRef.current.lookAt(end);
        hitMeshRef.current.rotateX(Math.PI / 2);
        hitMeshRef.current.scale.set(1, distance, 1);
      }

      if (arrowRef.current) {
        // Offset arrowhead to surface
        const dir = new THREE.Vector3().subVectors(end, start).normalize();
        const offsetEnd = end.clone().sub(dir.clone().multiplyScalar(0.6));
        arrowRef.current.position.copy(offsetEnd);
        arrowRef.current.lookAt(end);
        arrowRef.current.rotateX(Math.PI / 2);
      }
    }
  });

  const getColor = () => {
    if (isSelected || hovered) return '#FFFFFF';
    switch(edge.type) {
      case 'INHERITS':        return '#39FF14';
      case 'DEFINES':         return '#ffffff';
      case 'CALLS':           return '#FF5F1F';
      case 'DEPENDS_ON':      return '#00FFFF';
      case 'CORRELATES_WITH': return '#F59E0B';
      default: return '#888888';
    }
  };

  const isEnrichmentEdge = edge.type === 'CORRELATES_WITH';
  const enrichmentConfidence: number = isEnrichmentEdge ? (edge.metadata?.confidence ?? edge.confidence ?? 0.5) : 1;
  const baseEdgeOpacity = isSelected || hovered ? 1
    : isEnrichmentEdge ? Math.max(0.25, enrichmentConfidence * 0.85)
    : isNodeSelected ? 0.9
    : edge.type === 'DEFINES' ? 0.3
    : 0.6;
  const baseLineWidth = (isSelected || hovered) ? 4
    : isEnrichmentEdge ? 1.0
    : (isNodeSelected ? 3 : (edge.type === 'INHERITS' ? 2.5 : 1.5));

  const myelinBoost = cognitiveMesh?.myelination ? 1 + 2 * importance : 1;
  const prePruneOpacity = cognitiveMesh?.myelination ? Math.min(1, baseEdgeOpacity + 0.2 * importance) : baseEdgeOpacity;
  const isEdgePruned = !!(cognitiveMesh?.synapticPruning && importance < (cognitiveMesh?.pruneThreshold ?? 0.2) && !isSelected && !hovered);
  const preBlastOpacity = isEdgePruned ? prePruneOpacity * 0.15 : prePruneOpacity;
  const edgeOpacity = blastOpacity(isSelected, inDownstream, inUpstream, hasBlastSelection, preBlastOpacity);
  const lineWidth = baseLineWidth * myelinBoost;

  const isInherits = edge.type === 'INHERITS';
  const isCalls = edge.type === 'CALLS' || edge.type === 'DEPENDS_ON';

  return (
    <group>
      {/* Visible Line */}
      <Line 
         ref={lineRef}
         points={[edge.sourcePos, edge.targetPos]}
         color={getColor()}
         transparent
         opacity={edgeOpacity}
         lineWidth={lineWidth}
         dashed={edge.type === 'DEPENDS_ON' || edge.type === 'CALLS' || isEnrichmentEdge}
         dashScale={isEnrichmentEdge ? 3 : 2}
         dashSize={isEnrichmentEdge ? 0.35 : 0.5}
      />

      {/* UML Arrowhead */}
      {(isInherits || isCalls) && (
        <mesh ref={arrowRef}>
          {isInherits ? <coneGeometry args={[0.22, 0.45, 3]} /> : <coneGeometry args={[0.12, 0.35, 8]} />}
          <meshBasicMaterial 
            color={isInherits ? "#ffffff" : getColor()} 
            transparent 
            opacity={edgeOpacity * 1.5}
            wireframe={isInherits}
          />
        </mesh>
      )}

      {/* Semantic Predicate Label (UML Annotation) */}
      {(edge.type === 'REL' || edge.metadata?.predicate || isEnrichmentEdge) && (hovered || isNodeSelected) && (
        <Html
           position={new THREE.Vector3().addVectors(
             new THREE.Vector3().fromArray(edge.sourcePos),
             new THREE.Vector3().fromArray(edge.targetPos)
           ).multiplyScalar(0.5)}
           center
           distanceFactor={10}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.5 }}
            animate={{ opacity: 1, scale: 1 }}
            className={`px-2 py-0.5 rounded border shadow-lg flex flex-col items-center gap-0.5 ${
              isEnrichmentEdge
                ? 'bg-[#F59E0B]/80 border-[#F59E0B]/60'
                : 'bg-[#00FFFF]/80 border-white/40'
            }`}
          >
            <span className="text-[7px] font-black text-black uppercase tracking-widest whitespace-nowrap italic">
              {edge.metadata?.predicate || (isEnrichmentEdge ? 'correlates' : edge.type)}
            </span>
            {isEnrichmentEdge && (
              <span className="text-[6px] font-mono text-black/70 whitespace-nowrap">
                {Math.round(enrichmentConfidence * 100)}% confidence
              </span>
            )}
          </motion.div>
        </Html>
      )}

      {/* Invisible Hit-Tube */}
      <mesh 
        ref={hitMeshRef}
        onPointerOver={(e) => { e.stopPropagation(); setHovered(true); }}
        onPointerOut={() => setHovered(false)}
        onClick={(e) => { e.stopPropagation(); onClick(); }}
      >
        <cylinderGeometry args={[0.5, 0.5, 1, 6]} />
        <meshBasicMaterial visible={false} />
      </mesh>
    </group>
  );
}

// --- Immersive Navigation ---

function SpaceNavigator({ controlsRef }: { controlsRef: any }) {
  const [, getKeys] = useKeyboardControls();
  const { camera } = useThree();
  const speed = 15; // Movement speed in units per second

  useFrame((_state, delta) => {
    if (!controlsRef.current) return;

    const keys = getKeys();
    if (!keys) return;
    const { 
      forward = false, 
      backward = false, 
      left = false, 
      right = false, 
      ascend = false, 
      descend = false 
    } = keys;
    
    if (!forward && !backward && !left && !right && !ascend && !descend) return;

    const distance = speed * delta;

    // Movement deltas relative to camera orientation
    const moveZ = (forward ? 1 : 0) - (backward ? 1 : 0); // Positive = Forward
    const moveX = (right ? 1 : 0) - (left ? 1 : 0);    // Positive = Right
    const moveY = (ascend ? 1 : 0) - (descend ? 1 : 0); // Positive = Up

    // Lateral and Vertical movement (Trucking)
    if (moveX !== 0 || moveY !== 0) {
      controlsRef.current.truck(moveX * distance, moveY * distance, true);
    }

    // Forward/Backward movement
    if (moveZ !== 0) {
      const direction = new THREE.Vector3();
      camera.getWorldDirection(direction);
      direction.multiplyScalar(moveZ * distance);
      
      const newPos = camera.position.clone().add(direction);
      const target = new THREE.Vector3();
      controlsRef.current.getTarget(target);
      const newTarget = target.clone().add(direction);
      
      controlsRef.current.setLookAt(
        newPos.x, newPos.y, newPos.z,
        newTarget.x, newTarget.y, newTarget.z,
        true
      );
    }
  });

  return null;
}


const KEY_MAP = [
  { name: 'forward', keys: ['w', 'W', 'ArrowUp'] },
  { name: 'backward', keys: ['s', 'S', 'ArrowDown'] },
  { name: 'left', keys: ['a', 'A', 'ArrowLeft'] },
  { name: 'right', keys: ['d', 'D', 'ArrowRight'] },
  { name: 'ascend', keys: ['Space'] },
  { name: 'descend', keys: ['Shift'] },
];

function CodeGraphScene({
  processedGraph, selectedNodeId, selectedEdgeId, onNodeClick, onEdgeClick,
  cameraControlsRef, showClusters, graphRenderSettings,
  cognitiveMesh, analysis, blast, pulseEdgeKeys,
}: any) {
  const livePositions = useRef<Map<string, THREE.Vector3>>(new Map());
  const targetVec = useRef(new THREE.Vector3());
  const lastFrameTimeRef = useRef<number>(0);
  const frameIntervalRef = useRef<number>(1000 / graphRenderSettings.fpsCap);
  const { tier: zoomTier } = useSemanticZoom(!!cognitiveMesh?.semanticZoom);
  const [orbitTick, setOrbitTick] = useState(0); // force re-eval of selectedPos per frame
  const lastOrbitRef = useRef(0);
  useFrame(() => {
    if (!cognitiveMesh?.agentOrbit) return;
    const now = performance.now();
    if (now - lastOrbitRef.current > 100) {
      lastOrbitRef.current = now;
      setOrbitTick(t => t + 1);
    }
  });
  const selectedPos = selectedNodeId ? (livePositions.current.get(String(selectedNodeId)) || null) : null;
  void orbitTick;

  useEffect(() => {
    frameIntervalRef.current = 1000 / graphRenderSettings.fpsCap;
  }, [graphRenderSettings.fpsCap]);

  useFrame(() => {
    const now = performance.now();
    if (lastFrameTimeRef.current > 0 && now - lastFrameTimeRef.current < frameIntervalRef.current) {
      return;
    }
    lastFrameTimeRef.current = now;

    // Phase 4 Sync Loop: Lerp all live positions toward their targets
    if (!processedGraph?.nodes) return;

    processedGraph.nodes.forEach((node: any) => {
      if (!node.position || !Array.isArray(node.position)) return;

      const nid = String(node.id);
      targetVec.current.set(node.position[0] || 0, node.position[1] || 0, node.position[2] || 0);

      if (!livePositions.current.has(nid)) {
        livePositions.current.set(nid, targetVec.current.clone());
      } else {
        const live = livePositions.current.get(nid)!;
        live.lerp(targetVec.current, 0.05);
      }
    });
  });

  return (
    <>
      <color attach="background" args={['#020408']} />
      <ambientLight intensity={0.4} />
      <pointLight position={[10, 10, 10]} intensity={1} color="#00FFFF" />
      <Stars radius={100} depth={50} count={graphRenderSettings.starCount} factor={4} saturation={1} fade speed={1.5} />
      
      {/* Central Hub for Navigation Reference */}
      <mesh position={[0, 0, 0]}>
        <boxGeometry args={[2, 2, 2]} />
        <meshBasicMaterial color="#00FFFF" wireframe />
      </mesh>

      {processedGraph.nodes.map((node: any) => {
        const degree = analysis?.degreeMap.get(node.id) ?? 0;
        const maxDegree = analysis?.maxDegree ?? 1;
        const inDown = blast?.downstreamNodes?.has(node.id) ?? false;
        const inUp = blast?.upstreamNodes?.has(node.id) ?? false;
        return (
          <CodeSymbolNode
            key={node.id}
            {...node}
            livePositions={livePositions}
            isSelected={selectedNodeId === node.id}
            isClusterMode={showClusters}
            enableNodeRotation={graphRenderSettings.enableNodeRotation}
            onClick={() => onNodeClick(node)}
            cognitiveMesh={cognitiveMesh}
            degree={degree}
            maxDegree={maxDegree}
            zoomTier={zoomTier}
            inDownstream={inDown}
            inUpstream={inUp}
            hasBlastSelection={!!blast?.hasSelection}
          />
        );
      })}

      {processedGraph.edges.map((edge: any, i: number) => {
        const key = meshEdgeKey(edge);
        const importance = analysis?.edgeImportance.get(key) ?? 0;
        const inDown = blast?.downstreamEdgeKeys?.has(key) ?? false;
        const inUp = blast?.upstreamEdgeKeys?.has(key) ?? false;
        return (
          <CodeGraphEdge
            key={`${edge.source}-${edge.target}-${i}`}
            edge={edge}
            livePositions={livePositions}
            isSelected={selectedEdgeId === `${edge.source}-${edge.target}`}
            isNodeSelected={selectedNodeId === edge.source || selectedNodeId === edge.target}
            onClick={() => onEdgeClick(edge)}
            cognitiveMesh={cognitiveMesh}
            importance={importance}
            inDownstream={inDown}
            inUpstream={inUp}
            hasBlastSelection={!!blast?.hasSelection}
          />
        );
      })}

      {/* Cognitive Mesh Overlays (in-scene) */}
      {cognitiveMesh?.neuralNebula && analysis && showClusters && (
        <NeuralNebula
          centroids={analysis.communityCentroids}
          density={cognitiveMesh.particleDensity}
          enabled
          rotate={!!cognitiveMesh.clusterRotation}
        />
      )}
      {cognitiveMesh?.cycleDetection && analysis && (
        <CycleOverlay
          cycles={analysis.cycles}
          livePositions={livePositions}
          enabled
        />
      )}
      {cognitiveMesh?.dataFlowParticles && analysis && (
        <DataFlowParticles
          edges={processedGraph.edges.map((e: any) => ({
            source: String(e.source),
            target: String(e.target),
            type: e.type,
            importance: analysis.edgeImportance.get(meshEdgeKey(e)) ?? 0,
          }))}
          livePositions={livePositions}
          density={cognitiveMesh.particleDensity}
          pulseEdgeKeys={pulseEdgeKeys || new Set()}
        />
      )}
      {cognitiveMesh?.agentOrbit && (
        <AgentOrbit
          selectedPos={selectedPos}
          enabled={!!cognitiveMesh.agentOrbit}
        />
      )}

      {graphRenderSettings.enableFreeRotation ? (
        <OrbitControls
          makeDefault
          enableDamping
          dampingFactor={0.06}
          minDistance={5}
          maxDistance={400}
          zoomSpeed={0.5}
        />
      ) : (
        <>
          <SpaceNavigator controlsRef={cameraControlsRef} />
          <CameraControls
            ref={cameraControlsRef}
            makeDefault
            dollySpeed={0.2}
            minDistance={5}
            maxDistance={400}
            draggingSmoothTime={0.3}
            smoothTime={0.5}
          />
        </>
      )}
    </>
  );
}

// --- Main Canvas Component ---

export function CodeGraphCanvas() {
  const { currentWorkspace, activeGraphId, focusPath, setFocusPath } = useWorkspaceStore() as any;
  const {
    codeGraph, setCodeGraph, isCodeGraphScanOpen, setIsCodeGraphScanOpen,
    selectionTier,
    syncMode,
    visibleTypes,
    visibleEdgeTypes,
    showClusters,
    graphRenderSettings,
    cognitiveMesh,
    toggleCognitiveMesh,
  } = useWorkflowStore();
  const executionEvents = useWorkflowStore(s => s.executionEvents);
  
  const [directories, setDirectories] = useState<string[]>([]);
  const [selectedDir, setSelectedDir] = useState("/");
  const [scanName, setScanName] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const isFetching = useRef(false);
  const cameraControlsRef = useRef<any>(null);

  const flyToNode = (pos: [number, number, number]) => {
    if (cameraControlsRef.current) {
      cameraControlsRef.current.setLookAt(
        pos[0], pos[1] + 10, pos[2] + 20, // Camera pos
        pos[0], pos[1], pos[2],           // Target pos
        true                              // Transition
      );
    }
  };
  
  const handleRecenter = () => {
    if (cameraControlsRef.current) {
        cameraControlsRef.current.setLookAt(0, 40, 80, 0, 0, 0, true);
        setFocusPath(null);
        setSelectedNodeId(null);
    }
  };

  const fetchDirs = async () => {
    try {
      const resp = await fetch(`${API_BASE_URL}/api/graph/dirs?workspace=${currentWorkspace}`, {
         headers: { ...GOVERNANCE_HEADERS }
      });
      if (resp.ok) {
        const data = await resp.json();
        setDirectories(data.directories || ["/"]);
      }
    } catch (e) {
      console.error("Failed to fetch dirs", e);
    }
  };

  const fetchGraph = async () => {
    if (isFetching.current) return;
    isFetching.current = true;
    try {
      const snapshotParam = activeGraphId && activeGraphId !== 'neural_nexus' ? `&snapshot_id=${activeGraphId}` : '';
      const pathParam = focusPath ? `&path=${focusPath}` : '';

      // When enrichment is on, always use LOD endpoint so Concept nodes are included
      const useLoD = cognitiveMesh.knowledgeEnrichment || selectionTier !== 1 || !!focusPath;
      const endpoint = useLoD
        ? `${API_BASE_URL}/api/graph/code/lod?workspace=${currentWorkspace}&tier=${selectionTier}${snapshotParam}${pathParam}`
        : `${API_BASE_URL}/api/graph/code?workspace=${currentWorkspace}${snapshotParam}`;

      const resp = await fetch(endpoint, {
         headers: { ...GOVERNANCE_HEADERS }
      });
      if (resp.ok) {
        const data = await resp.json();
        if (data.nodes) {
          setCodeGraph(data);
          setIsCodeGraphScanOpen(false);
        }
      }
    } catch (e) {
      console.error("Failed to fetch graph", e);
    } finally {
      isFetching.current = false;
    }
  };

  const handleGenerate = async () => {
    setIsGenerating(true);
    try {
      const resp = await fetch(`${API_BASE_URL}/api/graph/code/generate`, {
        method: "POST",
        headers: { ...GOVERNANCE_HEADERS, "Content-Type": "application/json" },
        body: JSON.stringify({ 
          workspace: currentWorkspace, 
          root_dir: selectedDir === "/" ? "" : selectedDir,
          name: scanName || undefined
        })
      });
      if (resp.ok) {
        setTimeout(() => {
          fetchGraph();
          setIsGenerating(false);
          setIsCodeGraphScanOpen(false);
          setScanName("");
        }, 3000);
      }
    } catch (e) {
      console.error("Failed to generate", e);
      setIsGenerating(false);
    }
  };

  const handleDeepLayout = async () => {
    try {
      await fetch(`${API_BASE_URL}/api/graph/layout?workspace=${currentWorkspace}`, {
        method: "POST",
        headers: { ...GOVERNANCE_HEADERS }
      });
      fetchGraph();
    } catch (e) {
      console.error("Layout failed", e);
    }
  };

  // Layout logic
  const processedGraph = useMemo(() => {
    if (!codeGraph) return { nodes: [], edges: [] };

    const filteredSourceNodes = codeGraph.nodes.filter((n: any) => visibleTypes.includes(String(n.type)));

    // Pre-compute degree (total edge count) per node id
    const degreeMap: Record<string, number> = {};
    for (const edge of (codeGraph.edges || [])) {
      const s = String(edge.source);
      const t = String(edge.target);
      degreeMap[s] = (degreeMap[s] || 0) + 1;
      degreeMap[t] = (degreeMap[t] || 0) + 1;
    }
    const maxDegree = Math.max(1, ...Object.values(degreeMap));

    const nodes = filteredSourceNodes.map((node: any, i: number) => {
       const nodeId = String(node.id);
       const degree = degreeMap[nodeId] || 0;
       // Tree depth from file path (root = 1, each folder level +1)
       const parts = (node.path || "").split('/').filter(Boolean);
       const depth = Math.max(1, parts.length);
       // degree factor: more connections → larger (log-scaled, normalized 0–1)
       const degreeFactor = Math.log1p(degree) / Math.log1p(maxDegree);
       // depth factor: closer to root → larger (depth 1 = 1.0, depth 8+ = 0.4 min)
       const depthFactor = Math.max(0.4, 1 - (depth - 1) * 0.08);
       // Final scale: base 1.0, up to ~2x for highly-connected root nodes
       const scale = parseFloat((depthFactor * (1 + degreeFactor * 1.2)).toFixed(3));

       // Phase 4: Use backend coordinates if available
       if (node.position && (node.position[0] !== 0 || node.position[1] !== 0 || node.position[2] !== 0)) {
         return { ...node, id: nodeId, degree, depth, scale };
       }

       // Fallback to legacy circular layout if no backend coords
       const isSymbol = !['Folder', 'File'].includes(String(node.type));
       const nodeCount = filteredSourceNodes.length || 1;
       const baseAngle = (i / nodeCount) * Math.PI * 2;
       const baseRadius = depth * 6 + 10;

       const position: [number, number, number] = [
         Math.cos(baseAngle) * baseRadius,
         (isSymbol ? 5 : 0) + (Math.random() * 2),
         Math.sin(baseAngle) * baseRadius
       ];

       return { ...node, id: nodeId, degree, depth, scale, position };
    });

    const effectiveEdgeTypes = cognitiveMesh.knowledgeEnrichment
      ? [...visibleEdgeTypes, 'CORRELATES_WITH']
      : visibleEdgeTypes;

    const edges = codeGraph.edges.filter((e: any) => {
       const sid = String(e.source);
       const tid = String(e.target);
       const matchesFilter = effectiveEdgeTypes.includes(String(e.type));
       return matchesFilter && nodes.find(n => n.id === sid) && nodes.find(n => n.id === tid);
    }).map((edge: any) => {
       const sid = String(edge.source);
       const tid = String(edge.target);
       const sourceNode = nodes.find(n => n.id === sid);
       const targetNode = nodes.find(n => n.id === tid);
       return {
         ...edge,
         source: sid,
         target: tid,
         sourcePos: sourceNode?.position || [0,0,0],
         targetPos: targetNode?.position || [0,0,0]
       };
    });

    return { nodes, edges };
  }, [codeGraph, visibleTypes, visibleEdgeTypes, cognitiveMesh.knowledgeEnrichment]);

  const analysis = useMemo<MeshAnalysis | null>(() => {
    if (!processedGraph.nodes.length) return null;
    return analyzeMesh(processedGraph.nodes, processedGraph.edges);
  }, [processedGraph]);

  const blast = useBlastRadius(analysis, processedGraph.edges, selectedNodeId, !!cognitiveMesh.blastRadius);

  const pulseEdgeKeys = useMemo<Set<string>>(() => {
    const keys = new Set<string>();
    if (!cognitiveMesh.dataFlowParticles) return keys;
    const recent = executionEvents.slice(-25);
    for (const evt of recent) {
      if (!evt.nodeId) continue;
      for (const e of processedGraph.edges) {
        if (e.source === evt.nodeId || e.target === evt.nodeId) {
          keys.add(meshEdgeKey(e));
        }
      }
    }
    return keys;
  }, [executionEvents, processedGraph.edges, cognitiveMesh.dataFlowParticles]);

  // Sonification lifecycle
  useEffect(() => {
    Sonification.setEnabled(!!cognitiveMesh.sonification);
    Sonification.setAmbient(!!(cognitiveMesh.sonification && cognitiveMesh.ambientHeartbeat));
  }, [cognitiveMesh.sonification, cognitiveMesh.ambientHeartbeat]);

  // Audible pulse on execution events
  useEffect(() => {
    if (!cognitiveMesh.sonification || executionEvents.length === 0) return;
    const latest = executionEvents[executionEvents.length - 1];
    if (!latest) return;
    if (latest.type === 'node_error' || latest.type === 'workflow_failed') {
      Sonification.emit('error');
    } else if (latest.type === 'workflow_completed') {
      Sonification.emit('commit');
    } else {
      Sonification.pulseAmbient(0.6);
    }
  }, [executionEvents.length, cognitiveMesh.sonification]);

  const selectedNode = useMemo(() =>
    processedGraph.nodes.find((n: any) => n.id === selectedNodeId),
    [processedGraph.nodes, selectedNodeId]
  );

  const selectedEdge = useMemo(() => 
    processedGraph.edges.find((e: any) => `${e.source}-${e.target}` === selectedEdgeId),
    [processedGraph.edges, selectedEdgeId]
  );

  useEffect(() => {
    fetchDirs();
    fetchGraph();
    if (!focusPath && cameraControlsRef.current) {
        cameraControlsRef.current.setLookAt(0, 40, 80, 0, 0, 0, true);
    }
  }, [currentWorkspace, activeGraphId, focusPath, selectionTier, cognitiveMesh.knowledgeEnrichment]);

  // Sync Mode Polling (Phase 4 Streaming)
  useEffect(() => {
    if (syncMode === 'streaming') {
      const timer = setInterval(() => fetchGraph(), 5000);
      return () => clearInterval(timer);
    }
  }, [syncMode, currentWorkspace, selectionTier]);


  return (
    <div className="absolute inset-0 bg-[#020408]" onClick={() => { setSelectedNodeId(null); setSelectedEdgeId(null); }}>
      
      {/* Breadcrumbs (Repositioned to avoid Diagnostics) */}
      <div className="absolute top-12 left-12 z-10 flex items-center gap-2 bg-black/40 backdrop-blur-md border border-white/10 px-4 py-2 rounded-full shadow-[0_0_20px_rgba(0,0,0,0.5)]">
        <button 
          onClick={() => setFocusPath(null)}
          className={`p-1.5 rounded-full hover:bg-white/10 transition-all ${!focusPath ? 'text-[#00FFFF]' : 'text-white/40'}`}
        >
          <Home size={14} />
        </button>
        {focusPath && focusPath.split('/').filter(Boolean).map((part: string, i: number, arr: string[]) => (
          <React.Fragment key={i}>
            <ChevronRight size={12} className="text-white/20" />
            <button 
              onClick={() => setFocusPath(arr.slice(0, i + 1).join('/'))}
              className={`text-[10px] font-mono uppercase tracking-widest px-2 py-1 rounded hover:bg-white/5 transition-all ${i === arr.length - 1 ? 'text-[#00FFFF] font-black' : 'text-white/60'}`}
            >
              {part}
            </button>
          </React.Fragment>
        ))}
      </div>
      
      {/* 3D Canvas */}
      <div className="flex-1 w-full h-[calc(100vh-100px)] relative overflow-hidden">
        <KeyboardControls map={KEY_MAP}>
          <Canvas 
            camera={{ position: [0, 40, 80], fov: 60 }}
            onCreated={({ raycaster }) => { raycaster.params.Line.threshold = 0.5; }}
          >
            <CodeGraphScene
              processedGraph={processedGraph}
              selectedNodeId={selectedNodeId}
              selectedEdgeId={selectedEdgeId}
              onNodeClick={(node: any) => {
                setSelectedNodeId(node.id);
                if (cognitiveMesh.sonification) Sonification.emit('select', { nodeType: node.type });
                if (node.type === 'Folder') {
                   setFocusPath(node.id);
                   flyToNode(node.position);
                } else {
                   flyToNode(node.position);
                }
              }}
              onEdgeClick={(edge: any) => {
                setSelectedEdgeId(`${edge.source}-${edge.target}`);
                setSelectedNodeId(null);
                if (cognitiveMesh.sonification) Sonification.emit('edge_pulse');
              }}
              cameraControlsRef={cameraControlsRef}
              showClusters={showClusters}
              graphRenderSettings={graphRenderSettings}
              cognitiveMesh={cognitiveMesh}
              analysis={analysis}
              blast={blast}
              pulseEdgeKeys={pulseEdgeKeys}
            />
          </Canvas>
        </KeyboardControls>
      </div>


      {/* Smart Overlays */}
      <>

        {/* Community Legend HUD - Only visible in cluster mode */}
        {showClusters && (
          <motion.div 
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            className="absolute bottom-12 right-12 z-10 bg-black/60 backdrop-blur-xl border border-white/10 p-6 rounded-3xl w-72 shadow-2xl"
          >
            <div className="flex items-center gap-3 mb-4">
               <div className="w-2 h-2 rounded-full bg-[#00FFFF] animate-pulse" />
               <h3 className="text-sm text-white font-black uppercase tracking-widest">Semantic Landscape</h3>
            </div>
            <p className="text-[10px] text-white/40 leading-relaxed mb-4">
               Neighborhoods identified via Neural Synthesis. Common functional patterns are grouped by color.
            </p>
            <div className="space-y-2 max-h-48 overflow-y-auto pr-2 custom-scrollbar">
               {Array.from(new Set(processedGraph.nodes
                 .filter((n: any) => n.metadata?.community_id !== undefined)
                 .map((n: any) => JSON.stringify({id: n.metadata.community_id, name: n.metadata.community_name}))))
                 .slice(0, 10)
                 .map((json: any) => {
                   const {id, name} = JSON.parse(json);
                   return (
                     <div key={id} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-white/5 border border-white/10">
                        <div className="w-3 h-3 rounded-sm" style={{ backgroundColor: `hsl(${(id * 137.5) % 360}, 70%, 60%)` }} />
                        <span className="text-[10px] text-white/80 font-mono truncate">{name || `Community ${id}`}</span>
                     </div>
                   );
                 })
               }
               {processedGraph.nodes.length > 0 && (
                 <div className="flex items-center gap-2 px-3 py-1 opacity-50">
                    <span className="text-[9px] text-white/30 font-mono italic">Integrated {processedGraph.nodes.length} neural anchors</span>
                 </div>
               )}
            </div>
          </motion.div>
        )}

        {/* Modal Overlays */}
        <AnimatePresence>
          {isCodeGraphScanOpen && (
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0 z-50 flex items-center justify-center backdrop-blur-md bg-[#020408]/80"
            >
              <div className="bg-white/5 border border-[#00FFFF]/20 p-8 rounded-lg max-w-md w-full space-y-6">
                <div className="text-center space-y-2">
                  <Layers className="w-12 h-12 text-[#00FFFF] mx-auto animate-pulse" />
                  <h2 className="text-xl font-black tracking-[0.2em] text-[#00FFFF]">NEURAL_CODE_SCAN</h2>
                  <p className="text-[10px] text-[#00FFFF]/60 uppercase tracking-widest leading-relaxed">
                    Initialize recursive analysis to map your cross-stack architecture.
                  </p>
                </div>

              <div className="space-y-4">
                 <div className="space-y-1">
                    <div className="text-[8px] text-[#00FFFF]/40 uppercase tracking-widest pl-1">Target_Directory</div>
                    <div className="flex items-center gap-3 p-3 bg-white/5 border border-white/10 rounded-sm">
                        <FolderIcon className="w-4 h-4 text-[#00FFFF]/60" />
                        <select 
                        value={selectedDir}
                        onChange={(e) => setSelectedDir(e.target.value)}
                        className="bg-transparent border-none outline-none text-[11px] font-mono text-white flex-1 cursor-pointer"
                        >
                        {directories.map(d => (
                            <option key={d} value={d} className="bg-[#020408]">{d}</option>
                        ))}
                        </select>
                    </div>
                 </div>

                 <div className="space-y-1">
                    <div className="text-[8px] text-[#00FFFF]/40 uppercase tracking-widest pl-1">Snapshot_Identity</div>
                    <div className="flex items-center gap-3 p-3 bg-white/5 border border-white/10 rounded-sm">
                        <Terminal className="w-4 h-4 text-[#00FFFF]/60" />
                        <input 
                          type="text"
                          placeholder="SCAN_NAME (SNAPSHOT_0x1F)"
                          value={scanName}
                          onChange={(e) => setScanName(e.target.value)}
                          className="bg-transparent border-none outline-none text-[11px] font-mono text-white flex-1"
                        />
                    </div>
                 </div>

                 <button 
                   onClick={handleGenerate}
                   disabled={isGenerating}
                   className="w-full btn-pill h-12 flex items-center justify-center gap-3 bg-[#00FFFF]/10 border border-[#00FFFF]/60 text-[#00FFFF] group hover:bg-[#00FFFF]/20 disabled:opacity-50"
                 >
                   {isGenerating ? (
                      <RefreshCw className="w-4 h-4 animate-spin" />
                   ) : (
                      <Play className="w-4 h-4 group-hover:scale-125 transition-transform" />
                   )}
                   <span className="text-[10px] font-black tracking-[0.3em]">START_RECURSIVE_SCAN</span>
                 </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      </>

      {/* 4. Graph Command HUD (Tidied and Offset from HALT) */}
      <div className="absolute top-48 right-4 flex flex-col gap-3 pointer-events-auto z-40 bg-black/20 backdrop-blur-md p-3 rounded-2xl border border-white/5 shadow-2xl">
         <div className="text-[8px] font-black text-white/20 uppercase tracking-[0.2em] px-2 mb-1 flex items-center gap-2">
            <Settings size={10} /> Graph_Commands
         </div>
         <button 
           onClick={(e) => { e.stopPropagation(); handleRecenter(); }} 
           className="btn-pill px-5 h-10 flex items-center gap-3 bg-white/5 border border-white/10 hover:bg-white/20 transition-all group"
         >
            <Home size={14} className="text-white/40 group-hover:text-white transition-colors" /> 
            <span className="text-[10px] font-black tracking-[0.2em] text-white/40 group-hover:text-white">RE_CENTER</span>
         </button>
         
         <button onClick={(e) => { e.stopPropagation(); setIsCodeGraphScanOpen(true); }} className="btn-pill px-5 h-10 flex items-center gap-3 bg-[#00FFFF]/5 border border-[#00FFFF]/20 hover:border-[#00FFFF]/60 hover:bg-[#00FFFF]/10 transition-all group">
            <RefreshCw size={14} className={isGenerating ? "animate-spin text-[#00FFFF]" : "text-[#00FFFF]/60 group-hover:text-[#00FFFF]"} /> 
            <span className="text-[10px] font-black tracking-[0.2em] text-[#00FFFF]/60 group-hover:text-[#00FFFF]">RE_SCAN</span>
         </button>

         <button
           onClick={handleDeepLayout}
           className="btn-pill px-5 h-10 flex items-center gap-3 bg-white/5 border border-white/10 hover:bg-white/20 transition-all group"
         >
            <RefreshCw size={14} className="text-white/20 group-hover:text-white transition-colors" />
            <span className="text-[10px] font-black tracking-[0.2em] text-white/20 group-hover:text-white">DEEP_LAYOUT</span>
         </button>

         <div className="border-t border-white/5 my-1" />

         <button
           onClick={(e) => { e.stopPropagation(); toggleCognitiveMesh('knowledgeEnrichment'); }}
           className={`btn-pill px-5 h-10 flex items-center gap-3 transition-all group ${
             cognitiveMesh.knowledgeEnrichment
               ? 'bg-[#F59E0B]/15 border border-[#F59E0B]/60 hover:bg-[#F59E0B]/25'
               : 'bg-white/5 border border-white/10 hover:border-[#F59E0B]/40 hover:bg-[#F59E0B]/5'
           }`}
           title="Overlay CORRELATES_WITH edges from the knowledge graph onto the code graph"
         >
           <Link2
             size={14}
             className={cognitiveMesh.knowledgeEnrichment ? 'text-[#F59E0B]' : 'text-white/20 group-hover:text-[#F59E0B]/60 transition-colors'}
           />
           <span className={`text-[10px] font-black tracking-[0.2em] ${
             cognitiveMesh.knowledgeEnrichment ? 'text-[#F59E0B]' : 'text-white/20 group-hover:text-[#F59E0B]/60'
           }`}>
             {cognitiveMesh.knowledgeEnrichment ? 'ENRICHED' : 'ENRICH'}
           </span>
         </button>
      </div>

       {/* Cognitive Mesh DOM Overlays */}
       <AgenticPanel
         selectedNode={selectedNode}
         analysis={analysis}
         enabled={!!cognitiveMesh.agenticPanels}
         onAction={(id) => {
           if (id === 'trace' && cognitiveMesh.sonification) Sonification.emit('edge_pulse');
           if (id === 'prune' && cognitiveMesh.sonification) Sonification.emit('prune');
           if (id === 'summon' && selectedNode?.position) flyToNode(selectedNode.position);
         }}
       />
       <TimeTravelScrubber />

       {/* Selection Inspector */}
       <AnimatePresence>
          {(selectedNode || selectedEdge) && (
            <SymbolInspector 
              selection={selectedNode ? { type: 'node', data: selectedNode } : { type: 'edge', data: {
                ...selectedEdge,
                sourceName: processedGraph.nodes.find((n: any) => n.id === selectedEdge.source)?.name,
                targetName: processedGraph.nodes.find((n: any) => n.id === selectedEdge.target)?.name
              } }} 
              onClose={() => { setSelectedNodeId(null); setSelectedEdgeId(null); }}
            />
          )}
       </AnimatePresence>

    </div>
  );
}
