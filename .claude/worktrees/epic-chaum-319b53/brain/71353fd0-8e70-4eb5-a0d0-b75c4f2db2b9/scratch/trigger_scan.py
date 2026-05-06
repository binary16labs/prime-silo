import httpx
import json

def trigger_scan():
    url = "http://localhost:8005/api/graph/code/generate"
    payload = {
        "workspace": "v2_production",
        "root_dir": "",
        "name": "V2_High_Fidelity_Scan"
    }
    headers = {
        "Content-Type": "application/json",
        "X-Governance-Key": "BENNY_G3_ROOT"
    }
    
    with httpx.Client() as client:
        response = client.post(url, json=payload, headers=headers, timeout=60.0)
        print(f"Status: {response.status_code}")
        print(f"Response: {response.text}")

if __name__ == "__main__":
    trigger_scan()
