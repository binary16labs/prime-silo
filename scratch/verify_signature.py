import inspect
import sys
import os

# Ensure we can import from the local benny package
sys.path.insert(0, os.path.abspath('.'))

try:
    from benny.synthesis.engine import parallel_extract_triples
    
    print("\n--- Signature Verification ---")
    sig = inspect.signature(parallel_extract_triples)
    print(f"Function: {parallel_extract_triples.__name__}")
    print(f"Location: {inspect.getfile(parallel_extract_triples)}")
    print(f"Parameters: {list(sig.parameters.keys())}")
    
    if 'parallel_limit' in sig.parameters:
        print("\nSUCCESS: 'parallel_limit' is present in the signature.")
    else:
        print("\nFAILURE: 'parallel_limit' is MISSING from the signature.")
        
    if 'kwargs' in sig.parameters:
        print("SUCCESS: '**kwargs' is present in the signature (Bulletproof mode).")
    else:
        print("WARNING: '**kwargs' is missing.")

except Exception as e:
    print(f"Error importing parallel_extract_triples: {e}")
