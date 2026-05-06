import requests
import json
import sseclient
import threading
import time

API_BASE = "http://localhost:8000/api"

def test_hitl_flow():
    # 1. Start a workflow with an intervention node that will breach
    # Rule: 'forbidden'
    # Trigger message: 'This is a forbidden message'
    
    payload = {
        "nodes": [
            {"id": "node-1", "type": "trigger", "data": {"label": "Trigger"}},
            {"id": "node-2", "type": "intervention", "data": {
                "label": "Compliance Check",
                "config": {"rule": "forbidden", "description": "Breach: Restricted word used"}
            }},
            {"id": "node-3", "type": "llm", "data": {"label": "Assistant", "config": {"model": "Qwen3-8B-Hybrid"}}}
        ],
        "edges": [
            {"id": "e1", "source": "node-1", "target": "node-2"},
            {"id": "e2", "source": "node-2", "target": "node-3"}
        ],
        "workspace": "default",
        "message": "This contains the forbidden word"
    }
    
    print("Starting workflow...")
    response = requests.post(f"{API_BASE}/workflows/execute", json=payload)
    if response.status_code != 200:
        print(f"Failed to start: {response.text}")
        return
        
    run_data = response.json()
    run_id = run_data["run_id"]
    print(f"Run ID: {run_id}")
    
    # 2. Listen for SSE events
    sse_url = f"{API_BASE}/workflows/execute/{run_id}/events"
    
    def listen_sse():
        response = requests.get(sse_url, stream=True)
        client = sseclient.SSEClient(response)
        for event in client.events():
            data = json.loads(event.data)
            print(f"EVENT: {data.get('type')} - {data}")
            
            if data["type"] == "hitl_required":
                print("\n>>> HITL REQUIRED! Sending approval override...")
                # 3. Send HITL response
                time.sleep(1) # Small delay for realism
                resp = requests.post(f"{API_BASE}/workflows/execute/{run_id}/hitl-response", json={
                    "decision": "approve"
                })
                print(f"HITL Response status: {resp.status_code}")
                
            if data["type"] in ("workflow_completed", "workflow_failed"):
                print("\n>>> Workflow finished!")
                break

    listen_sse()

if __name__ == "__main__":
    test_hitl_flow()
