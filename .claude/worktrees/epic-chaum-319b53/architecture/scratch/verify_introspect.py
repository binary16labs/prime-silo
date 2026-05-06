"""
Scratch: Verify introspect_schema output against live Neo4j.
Run from the project root: python architecture/scratch/verify_introspect.py
"""
import sys, json
from pathlib import Path

# Add project root to path
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from benny.core.graph_db import introspect_schema

def main():
    workspace = "default"
    print(f"Calling introspect_schema('{workspace}')...")

    result = introspect_schema(workspace)

    required_keys = ["labels", "relationship_types", "entity_type_distribution"]
    passed = True

    for key in required_keys:
        val = result.get(key)
        if val is None:
            print(f"  ❌ MISSING key: {key}")
            passed = False
        elif not val:
            print(f"  ⚠️  EMPTY key:   {key}")
        else:
            print(f"  ✅ {key}: {json.dumps(val, indent=4, default=str)}")

    print()
    if passed:
        print("✅ introspect_schema PASSED — all required keys present.")
    else:
        print("❌ introspect_schema FAILED — see above for missing keys.")

if __name__ == "__main__":
    main()
