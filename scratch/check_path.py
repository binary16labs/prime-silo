import sys
import os
print("Python Path:")
for p in sys.path:
    print(f"  {p}")

try:
    import benny
    print(f"\nBenny package location: {benny.__file__}")
except ImportError:
    print("\nBenny package not found in path")
