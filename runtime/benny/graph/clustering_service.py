"""
Clustering Service - Topological community detection for the knowledge graph.
Implements a lightweight Label Propagation Algorithm (LPA) to identify 'Semantic Neighborhoods'.
"""

import logging
import asyncio
import anyio
from typing import Dict, List, Any, Set
from collections import Counter
from ..core.graph_db import get_driver

logger = logging.getLogger(__name__)

class ClusteringService:
    @staticmethod
    async def run_lpa_on_workspace(workspace: str, iterations: int = 5, auto_layout: bool = True) -> Dict[str, Any]:
        """
        Runs Label Propagation Algorithm on the graph for a specific workspace.
        Assigns a 'community_id' to every node (Concept, File, Symbol).
        """
        driver = get_driver()
        
        # 1. Fetch the adjacency list (only within the workspace)
        # We treat the graph as undirected for clustering purposes
        query = """
        MATCH (n {workspace: $workspace})
        OPTIONAL MATCH (n)-[r]-(m {workspace: $workspace})
        RETURN id(n) as node_id, collect(id(m)) as neighbors
        """
        
        nodes: Dict[int, int] = {} # node_id -> community_id
        adj: Dict[int, List[int]] = {}
        
        def _fetch_graph():
            with driver.session() as session:
                result = session.run(query, workspace=workspace)
                for record in result:
                    n_id = record["node_id"]
                    nodes[n_id] = n_id # Initial state: every node is its own community
                    adj[n_id] = [nb for nb in record["neighbors"] if nb is not None]
            return nodes, adj

        nodes, adj = await anyio.to_thread.run_sync(_fetch_graph)
        
        if not nodes:
            return {"status": "empty", "workspace": workspace}

        # 2. Iterate LPA
        def _iterate_lpa():
            for i in range(iterations):
                changes = 0
                node_ids = list(nodes.keys())
                for n_id in node_ids:
                    if not adj[n_id]:
                        continue
                    neighbor_communities = [nodes[nb] for nb in adj[n_id]]
                    if not neighbor_communities:
                        continue
                    most_common = Counter(neighbor_communities).most_common(1)[0][0]
                    if nodes[n_id] != most_common:
                        nodes[n_id] = most_common
                        changes += 1
                logger.info(f"LPA Iteration {i+1}: {changes} community changes in workspace {workspace}")
                if changes == 0:
                    break

        await anyio.to_thread.run_sync(_iterate_lpa)
        
        # 3. Write results back to Neo4j
        def _write_results():
            write_query = """
            UNWIND $data as item
            MATCH (n) WHERE id(n) = item.id
            SET n.community_id = item.community
            """
            data = [{"id": n_id, "community": c_id} for n_id, c_id in nodes.items()]
            with driver.session() as session:
                session.run(write_query, data=data)

        await anyio.to_thread.run_sync(_write_results)
            
        # 4. Generate Semantic Names for major communities
        from ..synthesis.engine import name_community
        
        community_members: Dict[int, List[str]] = {}
        def _fetch_members():
            name_query = """
            MATCH (n {workspace: $workspace})
            WHERE n.community_id IS NOT NULL
            RETURN n.community_id as community, n.name as name
            """
            with driver.session() as session:
                res = session.run(name_query, workspace=workspace)
                for record in res:
                    c_id = record["community"]
                    if c_id not in community_members: community_members[c_id] = []
                    community_members[c_id].append(record["name"])
            return community_members

        community_members = await anyio.to_thread.run_sync(_fetch_members)

        async def name_and_update(c_id, members):
            try:
                naming_res = await name_community(members, workspace=workspace)
                c_name = naming_res.get("community_name", "Cluster Hub")
                c_just = naming_res.get("justification", "")
                
                def _update_name():
                    update_name_query = """
                    MATCH (n {workspace: $workspace, community_id: $c_id})
                    SET n.community_name = $c_name, n.community_justification = $c_just
                    """
                    with driver.session() as session:
                        session.run(update_name_query, workspace=workspace, c_id=c_id, c_name=c_name, c_just=c_just)
                
                await anyio.to_thread.run_sync(_update_name)
            except Exception as e:
                logger.error(f"Failed to name community {c_id}: {e}")

        # Execute naming in parallel
        tasks = [name_and_update(c_id, members) for c_id, members in community_members.items() if len(members) >= 3]
        if tasks:
            await asyncio.gather(*tasks)

        # 5. Trigger Gravity Re-Indexing (Phase 4, D.1.3)
        if auto_layout:
            try:
                from .gravity_index import GravityIndex
                engine = GravityIndex(workspace)
                await engine.run()
                logger.info(f"GravityIndex: Auto-layout completed for {workspace}")
            except Exception as e:
                logger.error(f"GravityIndex: Failed to trigger auto-layout: {e}")

        return {
            "status": "completed",
            "workspace": workspace,
            "nodes_processed": len(nodes),
            "communities_found": len(set(nodes.values()))
        }

    @staticmethod
    def get_community_summary(workspace: str) -> List[Dict[str, Any]]:
        """Fetch a summary of discovered communities with their semantic names."""
        driver = get_driver()
        query = """
        MATCH (n {workspace: $workspace})
        WHERE n.community_id IS NOT NULL
        RETURN n.community_id as community, 
               n.community_name as name,
               collect(DISTINCT n.name) as members, 
               labels(n)[0] as type,
               count(*) as size
        ORDER BY size DESC
        LIMIT 50
        """
        with driver.session() as session:
            result = session.run(query, workspace=workspace)
            return [dict(record) for record in result]
