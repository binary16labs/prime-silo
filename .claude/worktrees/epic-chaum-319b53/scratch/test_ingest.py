import requests

url = "http://localhost:8005/api/graph/ingest"
payload = {
    "text": "The quick brown fox jumps over the lazy dog.",
    "source_name": "test_text",
    "workspace": "default",
    "provider": "lemonade",
    "model": "deepseek-r1-8b-FLM",
    "embed": True,
    "embedding_provider": "local",
    "embedding_model": "nomic-embed-text-v1-GGUF"
}

try:
    response = requests.post(url, json=payload)
    print(f"Status Code: {response.status_code}")
    print(f"Response: {response.text}")
except Exception as e:
    print(f"Error: {e}")
