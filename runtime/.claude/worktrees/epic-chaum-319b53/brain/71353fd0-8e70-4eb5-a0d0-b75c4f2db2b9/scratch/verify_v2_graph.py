import httpx
import json

def check_graph_count():
    url = "http://localhost:8005/api/graph/code?workspace=v2_production"
    headers = {
        "X-Governance-Key": "BENNY_G3_ROOT"
    }
    
    with httpx.Client() as client:
        response = client.get(url, headers=headers, timeout=120.0)
        if response.status_code == 200:
            data = response.json()
            nodes = data.get("nodes", [])
            print(f"Total Nodes in v2_production: {len(nodes)}")
            
            # Type breakdown
            types = {}
            short_names = []
            paths = set()
            for n in nodes:
                t = n.get("type")
                types[t] = types.get(t, 0) + 1
                if t == "Function" and len(n.get("name", "")) <= 2:
                    short_names.append(n.get("name"))
                paths.add(n.get("path", ""))
            
            print("\nType Breakdown:")
            for t, count in types.items():
                print(f"  {t}: {count}")
                
            print(f"\nFunctions with names <= 2 chars: {len(short_names)}")
            
            # Check for dist or node_modules in paths
            junk_paths = [p for p in paths if "dist" in p or "node_modules" in p]
            print(f"Nodes found in dist/node_modules: {len(junk_paths)}")
            if junk_paths:
                print("Sample junk paths:", junk_paths[:5])
        else:
            print(f"Error: {response.status_code}")

if __name__ == "__main__":
    check_graph_count()
