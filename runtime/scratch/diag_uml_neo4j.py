"""
Deep diagnostic for c3_teest UML edges.
Checks: (1) what edge types are stored in Neo4j, (2) whether Import/ExternalClass nodes exist,
(3) whether the get_workspace_graph query is filtering them out.
"""
import sys, os
sys.path.insert(0, os.getcwd())

from benny.core.graph_db import read_session

WORKSPACE = "c3_teest"

def run():
    with read_session() as s:

        # 1. Latest snapshot ID
        snap = s.run("""
            MATCH (sc:CodeScan {workspace: $ws})
            RETURN sc.scan_id AS id, sc.created_at AS ts
            ORDER BY sc.created_at DESC LIMIT 3
        """, ws=WORKSPACE)
        snaps = list(snap)
        print(f"== Scans for '{WORKSPACE}' ==")
        for row in snaps:
            print(f"  scan_id={row['id']}  created_at={row['ts']}")

        if not snaps:
            print("NO SCANS FOUND. Did the scan complete?")
            return

        snap_id = snaps[0]["id"]
        print(f"\nUsing latest snapshot: {snap_id}\n")

        # 2. Node type distribution in this snapshot
        res = s.run("""
            MATCH (n:CodeEntity {workspace: $ws, snapshot_id: $snap})
            RETURN n.type AS type, count(n) AS cnt
            ORDER BY cnt DESC
        """, ws=WORKSPACE, snap=snap_id)
        print("== Node Types in snapshot ==")
        rows = list(res)
        for row in rows:
            print(f"  {row['type']:20} {row['cnt']}")
        if not rows:
            print("  (none)")

        # 3. CODE_REL edge types in this snapshot
        res = s.run("""
            MATCH (s:CodeEntity {workspace: $ws, snapshot_id: $snap})
                  -[r:CODE_REL {snapshot_id: $snap}]->
                  (t:CodeEntity {workspace: $ws, snapshot_id: $snap})
            RETURN r.type AS type, count(r) AS cnt
            ORDER BY cnt DESC
        """, ws=WORKSPACE, snap=snap_id)
        print("\n== CODE_REL Edge Types (all) ==")
        rows = list(res)
        for row in rows:
            print(f"  {row['type']:20} {row['cnt']}")
        if not rows:
            print("  (none)")

        # 4. Check whether INHERITS edges exist at all (target may be ExternalClass)
        res = s.run("""
            MATCH (s:CodeEntity {workspace: $ws, snapshot_id: $snap})
                  -[r:CODE_REL {type: 'INHERITS', snapshot_id: $snap}]->
                  (t:CodeEntity)
            RETURN s.name AS src, t.name AS tgt, t.workspace AS tgt_ws, t.snapshot_id AS tgt_snap
            LIMIT 10
        """, ws=WORKSPACE, snap=snap_id)
        print("\n== INHERITS edges (source scoped, target any) ==")
        rows = list(res)
        for row in rows:
            print(f"  {row['src']} --> {row['tgt']}  (tgt_ws={row['tgt_ws']}, tgt_snap={row['tgt_snap']})")
        if not rows:
            print("  (none found)")

        # 5. Check DEPENDS_ON edges similarly
        res = s.run("""
            MATCH (s:CodeEntity {workspace: $ws, snapshot_id: $snap})
                  -[r:CODE_REL {type: 'DEPENDS_ON', snapshot_id: $snap}]->
                  (t:CodeEntity)
            RETURN s.name AS src, t.name AS tgt, t.type AS tgt_type
            LIMIT 10
        """, ws=WORKSPACE, snap=snap_id)
        print("\n== DEPENDS_ON edges (source scoped, target any) ==")
        rows = list(res)
        for row in rows:
            print(f"  {row['src']} --> {row['tgt']}  (type={row['tgt_type']})")
        if not rows:
            print("  (none found)")

        # 6. Check if Import/ExternalClass nodes exist but LACK snapshot_id scoping
        res = s.run("""
            MATCH (n:CodeEntity {workspace: $ws})
            WHERE n.type IN ['Import', 'ExternalClass'] AND n.snapshot_id IS NULL
            RETURN n.type AS type, count(n) AS cnt
        """, ws=WORKSPACE)
        print("\n== Import/ExternalClass nodes MISSING snapshot_id ==")
        rows = list(res)
        for row in rows:
            print(f"  type={row['type']}  count={row['cnt']}")
        if not rows:
            print("  (none — all have snapshot_id, good)")

        # 7. Raw check: do Import or ExternalClass nodes exist with correct snapshot?
        res = s.run("""
            MATCH (n:CodeEntity {workspace: $ws, snapshot_id: $snap})
            WHERE n.type IN ['Import', 'ExternalClass']
            RETURN n.type AS type, n.name AS name LIMIT 10
        """, ws=WORKSPACE, snap=snap_id)
        print("\n== Import / ExternalClass nodes in snapshot ==")
        rows = list(res)
        for row in rows:
            print(f"  [{row['type']}] {row['name']}")
        if not rows:
            print("  (none)")

        # 8. get_workspace_graph OPTIONAL MATCH means target must also match ws+snap
        # Test: do INHERITS targets have the same workspace + snapshot_id?
        res = s.run("""
            MATCH (s:CodeEntity {workspace: $ws, snapshot_id: $snap})
                  -[r:CODE_REL {type: 'INHERITS', snapshot_id: $snap}]->(t)
            WHERE NOT (t.workspace = $ws AND t.snapshot_id = $snap)
            RETURN s.name AS src, t.name AS tgt,
                   t.workspace AS tgt_ws, t.snapshot_id AS tgt_snap,
                   t.type AS tgt_type
            LIMIT 10
        """, ws=WORKSPACE, snap=snap_id)
        print("\n== INHERITS targets that DON'T match ws+snap (get_workspace_graph would MISS these) ==")
        rows = list(res)
        for row in rows:
            print(f"  {row['src']} --> {row['tgt']}  ws={row['tgt_ws']} snap={row['tgt_snap']} type={row['tgt_type']}")
        if not rows:
            print("  (none — all targets in scope, or no INHERITS at all)")

if __name__ == "__main__":
    run()
