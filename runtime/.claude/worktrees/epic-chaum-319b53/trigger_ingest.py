import requests
import json

response = requests.post(
    "http://localhost:8005/api/rag/ingest",
    json={"workspace": "default", "files": ["the_dog.pdf"]}
)
print("Status:", response.status_code)
print(json.dumps(response.json(), indent=2))
