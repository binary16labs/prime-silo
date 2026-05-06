import httpx
import time
import json
import os
from pathlib import Path

BASE_URL = "http://localhost:8005/api"
HEADERS = {"X-Benny-API-Key": "benny-mesh-2026-auth"}
WORKSPACE = "verif_ws"

def test_lineage_fix():
    print(f"--- Starting Verification in Workspace: {WORKSPACE} ---")
    timeout = httpx.Timeout(30.0, connect=10.0)
    client = httpx.Client(timeout=timeout)
    
    # 1. Upload a .txt file
    filename = "lineage_test.txt"
    content = "This is a test file for lineage tracking."
    
    with open(filename, "w") as f:
        f.write(content)
        
    print(f"Step 1: Uploading {filename}...")
    files = {"file": (filename, open(filename, "rb"), "text/plain")}
    res = client.post(f"{BASE_URL}/files/upload?workspace={WORKSPACE}", headers=HEADERS, files=files)
    print(f"Upload Status: {res.status_code}")
    if res.status_code != 200:
        print(f"Error: {res.text}")
    else:
        print(res.json())
    
    # Wait for async worker
    time.sleep(2)
    
    # Check gov log
    gov_log = Path("workspace/governance.log")
    if gov_log.exists():
        with open(gov_log, "r") as f:
            lines = f.readlines()
            # Check for LINEAGE_FILE_CONVERSION with job_name file_upload
            found = False
            for line in reversed(lines):
                data = json.loads(line)
                if data.get("event_type") == "LINEAGE_FILE_CONVERSION" and data.get("workspace") == WORKSPACE:
                    if data["data"]["job"]["name"].endswith("file_upload"):
                        print(f"✅ Found LINEAGE_FILE_CONVERSION event for upload in {WORKSPACE}")
                        found = True
                        break
            if not found:
                print("❌ Could NOT find LINEAGE_FILE_CONVERSION event for upload")
    else:
        print("❌ governance.log not found")

    # 2. Run RAG Ingestion
    print(f"\nStep 2: Triggering RAG ingestion for {filename}...")
    ingest_payload = {
        "workspace": WORKSPACE,
        "files": [filename]
    }
    res = client.post(f"{BASE_URL}/rag/ingest", headers=HEADERS, json=ingest_payload)
    print(f"Ingest Status: {res.status_code}")
    print(res.json())
    
    time.sleep(2)
    
    # Check gov log for START event with inputs
    if gov_log.exists():
        with open(gov_log, "r") as f:
            lines = f.readlines()
            found = False
            for line in reversed(lines):
                data = json.loads(line)
                if data.get("event_type") == "LINEAGE_START_WORKFLOW" and data.get("workspace") == WORKSPACE:
                    inputs = data["data"].get("inputs", [])
                    if len(inputs) > 0 and filename in str(inputs):
                        print(f"✅ Found LINEAGE_START_WORKFLOW event with inputs: {inputs}")
                        found = True
                        break
            if not found:
                print("❌ Could NOT find LINEAGE_START_WORKFLOW event with populated inputs")
                
            # Check for COMPLETE event with outputs
            found = False
            for line in reversed(lines):
                data = json.loads(line)
                if data.get("event_type") == "LINEAGE_COMPLETE_WORKFLOW" and data.get("workspace") == WORKSPACE:
                    outputs = data["data"].get("outputs", [])
                    if len(outputs) > 0 and "chromadb" in str(outputs):
                        print(f"✅ Found LINEAGE_COMPLETE_WORKFLOW event with outputs: {outputs}")
                        found = True
                        break
            if not found:
                 # Check for default workspace if mirror didn't catch it correctly in gov log
                 print("Checking for COMPLETE event in default/global if not found in workspace...")
                 for line in reversed(lines):
                    data = json.loads(line)
                    if data.get("event_type") == "LINEAGE_COMPLETE_WORKFLOW":
                        outputs = data["data"].get("outputs", [])
                        if len(outputs) > 0 and "chromadb" in str(outputs):
                            print(f"✅ Found LINEAGE_COMPLETE_WORKFLOW event (global) with outputs: {outputs}")
                            found = True
                            break
    
    # Cleanup
    if os.path.exists(filename):
        os.remove(filename)
    print("\n--- Verification Finished ---")

if __name__ == "__main__":
    try:
        test_lineage_fix()
    except Exception as e:
        print(f"Test failed: {e}")
