import requests
import json

try:
    response = requests.get("http://localhost:13305/api/v1/models?show_all=true")
    if response.status_code == 200:
        data = response.json()
        downloaded_models = [m['id'] for m in data.get('data', []) if m.get('downloaded')]
        print("Downloaded models:")
        for m in downloaded_models:
            print(f"- {m}")
        
        all_models = [m['id'] for m in data.get('data', [])]
        print("\nAll model IDs (first 20):")
        for m in all_models[:20]:
            print(f"- {m}")
    else:
        print(f"Error: {response.status_code}")
except Exception as e:
    print(f"Error: {e}")
