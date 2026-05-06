"""
Verify UML Extraction — no Neo4j required.
Tests that code_analyzer correctly extracts INHERITS, DEPENDS_ON, CALLS, and DEFINES edges
from an inline Python snippet.
"""
import sys, os, tempfile
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from benny.graph.code_analyzer import CodeGraphAnalyzer

SAMPLE_CODE = '''
import os
from pathlib import Path

class Animal:
    def speak(self):
        pass

class Dog(Animal):
    def bark(self):
        self.speak()

def standalone_func():
    pass
'''

def main():
    with tempfile.TemporaryDirectory() as tmp:
        sample_file = os.path.join(tmp, "sample.py")
        with open(sample_file, "w", encoding="utf-8") as f:
            f.write(SAMPLE_CODE)

        analyzer = CodeGraphAnalyzer(tmp)
        result = analyzer.analyze_workspace()

    nodes = result["nodes"]
    edges = result["edges"]

    node_types = {n["type"] for n in nodes}
    edge_types  = {e["type"] for e in edges}

    print(f"\n{'='*50}")
    print(f"Nodes found ({len(nodes)}):")
    for n in sorted(nodes, key=lambda x: x["type"]):
        print(f"  [{n['type']:14}] {n['name']}")

    print(f"\nEdges found ({len(edges)}):")
    for e in sorted(edges, key=lambda x: x["type"]):
        print(f"  [{e['type']:12}] {e['source']}  -->  {e['target']}")

    print(f"\n{'='*50}")
    print("Edge types present:", edge_types)

    # --- Assertions ---
    failures = []

    if "DEFINES" not in edge_types:
        failures.append("❌ DEFINES missing — Structural edges broken")
    else:
        print("✅ DEFINES edges present")

    if "INHERITS" not in edge_types:
        failures.append("❌ INHERITS missing — Lineage (Bug 1) not fixed")
    else:
        print("✅ INHERITS edges present (Bug 1 fixed)")

    if "DEPENDS_ON" not in edge_types:
        failures.append("❌ DEPENDS_ON missing — Dependency (Bug 2) not fixed")
    else:
        print("✅ DEPENDS_ON edges present (Bug 2 fixed)")

    if "CALLS" not in edge_types:
        failures.append("❌ CALLS missing — Flow (Bug 3) not fixed")
    else:
        print("✅ CALLS edges present (Bug 3 fixed)")

    if "Import" not in node_types:
        failures.append("❌ Import node type missing — import nodes not created")
    else:
        print("✅ Import nodes created")

    if "ExternalClass" not in node_types:
        failures.append("❌ ExternalClass missing — virtual inheritance nodes not created")
    else:
        print("✅ ExternalClass (virtual) nodes created")

    print(f"\n{'='*50}")
    if failures:
        print("FAILURES:")
        for f in failures:
            print(f"  {f}")
        sys.exit(1)
    else:
        print("ALL CHECKS PASSED ✅")

if __name__ == "__main__":
    main()
