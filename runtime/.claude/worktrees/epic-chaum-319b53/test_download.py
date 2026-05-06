import requests
import json
url = "http://localhost:8005/api/files/download-url"
data = {"url": "https://www.gutenberg.org/cache/epub/32300/pg32300-images.html", "workspace": "default"}
res = requests.post(url, json=data)
print(res.status_code)
print(res.json())
