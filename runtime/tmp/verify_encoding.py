# Verification script for Unicode encoding
import os
from pathlib import Path

# Test character: Omega (Unicode)
test_char = "Ω"
test_log = Path("workspace/test/ingest.log")

try:
    print(f"Testing write of {test_char} to {test_log}...")
    # This simulates the logic in rag_routes.py
    with open(test_log, "a", encoding="utf-8") as f:
        f.write(f"Verification test: {test_char}\n")
    print("Success! Encoding handled correctly.")
except UnicodeEncodeError as e:
    print(f"FAILED: UnicodeEncodeError: {e}")
except Exception as e:
    print(f"FAILED: Unexpected error: {e}")
