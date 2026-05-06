"""
Gravity Index — 3D Spatial Positioning Engine.

Calculates high-fidelity 3D coordinates for all graph nodes using a 
community-aware force-directed algorithm. 

Key principles:
  - Repulsion: All nodes push away to prevent overlap.
  - Attraction: Connected nodes pull together.
  - Gravity: Community hubs act as gravitational centers for their clusters.
  - Bounds: All coordinates normalized to a [-100, 100] cube.
"""

import math
import random
import logging
from typing import Dict, List, Any, Tuple
from ..core.graph_db import get_driver, read_session, write_session

logger = logging.getLogger(__name__)

class GravityIndex:
    def __init__(self, workspace: str):
        self.workspace = workspace
        self.nodes: List[Dict[str, Any]] = []
        self.edges: List[Tuple[int, int]] = []
        self.positions: Dict[int, List[float]] = {} # node_id -> [x, y, z]
        self.communities: Dict[int, int] = {}       # node_id -> community_id
        
    async def load_graph(self):
        """Fetch all nodes and edges for the workspace."""
        query = """
        MATCH (n {workspace: $ws})
        OPTIONAL MATCH (n)-[r]-(m {workspace: $ws})
        RETURN id(n) as id, n.name as name, n.type as type, n.community_id as community,
               collect(id(m)) as neighbors
        """
        with read_session() as session:
            result = session.run(query, ws=self.workspace)
            for record in result:
                n_id = record["id"]
                self.nodes.append(record)
                self.communities[n_id] = record["community"]
                for nb_id in record["neighbors"]:
                    if nb_id:
                        self.edges.append((n_id, nb_id))
        
        # Initialize random positions
        for node in self.nodes:
            self.positions[node["id"]] = [
                random.uniform(-50, 50),
                random.uniform(-50, 50),
                random.uniform(-50, 50)
            ]

    def _compute_forces(self, iterations: int = 25):
        """Fruchterman-Reingold inspired 3D layout with community gravity."""
        node_count = len(self.nodes)
        if node_count == 0: return
        
        k = math.sqrt(100**3 / node_count) # Optimal distance
        t = 10.0 # Temperature (decreases over time)
        
        # Optimization: Distance cutoff for repulsion (squared for speed)
        cutoff_sq = (k * 4) ** 2

        for i in range(iterations):
            disp: Dict[int, List[float]] = {n["id"]: [0.0, 0.0, 0.0] for n in self.nodes}
            
            # 1. Repulsion (between all nodes)
            for j, v in enumerate(self.nodes):
                v_id = v["id"]
                v_pos = self.positions[v_id]
                for k_idx, u in enumerate(self.nodes):
                    if j == k_idx: continue
                    u_id = u["id"]
                    u_pos = self.positions[u_id]
                    
                    dx = v_pos[0] - u_pos[0]
                    dy = v_pos[1] - u_pos[1]
                    dz = v_pos[2] - u_pos[2]
                    
                    dist_sq = dx*dx + dy*dy + dz*dz + 0.01
                    if dist_sq > cutoff_sq: continue # Optimization: Skip if too far
                    
                    dist = math.sqrt(dist_sq)
                    mag = (k*k) / dist
                    
                    disp[v_id][0] += (dx/dist) * mag
                    disp[v_id][1] += (dy/dist) * mag
                    disp[v_id][2] += (dz/dist) * mag
            
            # 2. Attraction (along edges)
            for v_id, u_id in self.edges:
                v_pos = self.positions[v_id]
                u_pos = self.positions[u_id]
                dx = v_pos[0] - u_pos[0]
                dy = v_pos[1] - u_pos[1]
                dz = v_pos[2] - u_pos[2]
                
                dist = math.sqrt(dx*dx + dy*dy + dz*dz) + 0.1
                mag = (dist*dist) / k
                
                disp[v_id][0] -= (dx/dist) * mag
                disp[v_id][1] -= (dy/dist) * mag
                disp[v_id][2] -= (dz/dist) * mag
                
                disp[u_id][0] += (dx/dist) * mag
                disp[u_id][1] += (dy/dist) * mag
                disp[u_id][2] += (dz/dist) * mag

            # 3. Community Gravity (pull nodes of same community to cluster center)
            # (Simplified: pull towards a fixed offset based on community_id)
            for v in self.nodes:
                v_id = v["id"]
                c_id = v["community"]
                if c_id is not None:
                    # Target center for this community
                    seed = hash(str(c_id))
                    target_x = (seed % 100) - 50
                    target_y = ((seed >> 4) % 100) - 50
                    target_z = ((seed >> 8) % 100) - 50
                    
                    dx = target_x - self.positions[v_id][0]
                    dy = target_y - self.positions[v_id][1]
                    dz = target_z - self.positions[v_id][2]
                    
                    # Pull nodes toward their community orbit
                    disp[v_id][0] += dx * 0.1
                    disp[v_id][1] += dy * 0.1
                    disp[v_id][2] += dz * 0.1

            # 4. Apply displacement with cooling
            for v in self.nodes:
                v_id = v["id"]
                d = disp[v_id]
                dist = math.sqrt(d[0]*d[0] + d[1]*d[1] + d[2]*d[2]) + 0.1
                
                self.positions[v_id][0] += (d[0]/dist) * min(dist, t)
                self.positions[v_id][1] += (d[1]/dist) * min(dist, t)
                self.positions[v_id][2] += (d[2]/dist) * min(dist, t)
                
                # Keep within bounds
                self.positions[v_id] = [
                    max(-100, min(100, x)) for x in self.positions[v_id]
                ]
            
            t *= 0.95 # Cooling
            if t < 0.1: break

    async def save_layout(self):
        """Persist calculated coordinates back to Neo4j properties."""
        write_query = """
        UNWIND $data as item
        MATCH (n) WHERE id(n) = item.id
        SET n.pos_x = item.x, n.pos_y = item.y, n.pos_z = item.z
        """
        data = [
            {"id": n_id, "x": pos[0], "y": pos[1], "z": pos[2]}
            for n_id, pos in self.positions.items()
        ]
        with write_session() as session:
            session.run(write_query, data=data)
            
    async def run(self):
        """Full execution cycle."""
        logger.info(f"GravityIndex: Running layout calculation for {self.workspace}")
        await self.load_graph()
        if not self.nodes:
            return {"status": "no_nodes"}
        
        # Phase 4 Stabilization: Run CPU-bound math in a background thread
        import asyncio
        await asyncio.to_thread(self._compute_forces)
        
        await self.save_layout()
        
        logger.info(f"GravityIndex: Layout finalized for {len(self.nodes)} nodes")
        return {
            "status": "completed",
            "node_count": len(self.nodes),
            "bounds": [-100, 100]
        }
