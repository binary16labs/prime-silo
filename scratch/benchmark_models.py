import asyncio
import os
import sys
from pathlib import Path
import json
import time

# Ensure we can import benny
sys.path.append(str(Path(__file__).parent.parent))

from benny.synthesis.engine import extract_directed_triples_from_section, SynthesisConfig

async def benchmark():
    print("Starting Model Benchmark on Lemonade: Gemma-4 vs Qwen-tk")
    
    # Configuration
    workspace = "c4_test"
    sample_file = Path(rf"c:\Users\nsdha\OneDrive\code\benny\workspace\{workspace}\staging\Tales of Space and Time.md")
    
    if not sample_file.exists():
        print(f"Error: Sample file not found at {sample_file}")
        return

    # Load text
    full_text = sample_file.read_text(encoding="utf-8")
    # Small segment for fast verification
    segment = full_text[5000:5800]
    
    models = {
        "Gemma-4 (GGUF)": "lemonade/Gemma-4-E4B-it-GGUF",
        "Qwen-tk (FLM)": "lemonade/qwen3-tk-4b-FLM"
    }
    
    results = []
    
    for label, model_id in models.items():
        print(f"\n--- Testing {label} ({model_id}) ---")
        start_time = time.time()
        try:
            config = SynthesisConfig(min_confidence=0.5, max_retries=1)
            
            triples = await extract_directed_triples_from_section(
                text=segment,
                section_title="Benchmark Segment",
                model=model_id,
                config=config,
                workspace=workspace
            )
            
            duration = time.time() - start_time
            results.append({
                "model": label,
                "count": len(triples),
                "duration": f"{duration:.2f}s",
                "status": "Success",
                "samples": [f"{t.subject} -> {t.predicate} -> {t.object}" for t in triples[:3]]
            })
            print(f"Success: Extracted {len(triples)} triples in {duration:.2f}s")
            
        except Exception as e:
            duration = time.time() - start_time
            print(f"Error for {label}: {e}")
            results.append({
                "model": label,
                "count": 0,
                "duration": f"{duration:.2f}s",
                "status": f"Failed: {str(e)[:150]}",
                "samples": []
            })

    # Output results
    print("\nBENCHMARK_RESULTS_START")
    print(json.dumps(results, indent=2))
    print("BENCHMARK_RESULTS_END")

if __name__ == "__main__":
    asyncio.run(benchmark())
