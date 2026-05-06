"""
FastFlowLM Test Script - Verify connection to local LLM
Based on dangpy configuration: port 52625, model gemma3:4b
"""

import requests
import json


def test_fastflowlm():
    """Test FastFlowLM connection on port 52625"""
    url = "http://localhost:52625/v1/chat/completions"
    headers = {"Content-Type": "application/json"}
    payload = {
        "model": "gemma3:4b",
        "messages": [{"role": "user", "content": "Hello, respond with 'FastFlowLM is working!'"}],
        "temperature": 0.7,
        "max_tokens": 50
    }
    
    print("=" * 60)
    print("FastFlowLM Connection Test")
    print("=" * 60)
    print(f"URL: {url}")
    print(f"Model: {payload['model']}")
    print()
    
    # Test models endpoint first
    print("Testing /v1/models endpoint...")
    try:
        models_resp = requests.get("http://localhost:52625/v1/models", timeout=5)
        print(f"  Status: {models_resp.status_code}")
        if models_resp.status_code == 200:
            models = models_resp.json()
            print(f"  Available models: {json.dumps(models, indent=2)[:200]}")
    except requests.exceptions.ConnectionError:
        print("  ❌ Connection refused - FastFlowLM not running")
        print()
        print("To start FastFlowLM:")
        print("  1. Ensure Intel NPU drivers are installed")
        print("  2. Start FastFlowLM server on port 52625")
        return False
    except Exception as e:
        print(f"  ❌ Error: {e}")
        return False
    
    print()
    print("Testing /v1/chat/completions endpoint...")
    try:
        resp = requests.post(url, headers=headers, json=payload, timeout=30)
        print(f"  Status: {resp.status_code}")
        
        if resp.status_code == 200:
            result = resp.json()
            content = result.get("choices", [{}])[0].get("message", {}).get("content", "")
            print(f"  ✅ Response: {content[:100]}")
            return True
        else:
            print(f"  ❌ Error: {resp.text[:200]}")
            return False
            
    except requests.exceptions.Timeout:
        print("  ⚠️ Request timed out - model may be loading")
        return False
    except Exception as e:
        print(f"  ❌ Error: {e}")
        return False


def test_all_providers():
    """Test all local LLM providers"""
    providers = [
        ("Lemonade", "http://localhost:8080/api/v1/models"),
        ("Ollama", "http://localhost:11434/v1/models"),
        ("FastFlowLM", "http://localhost:52625/v1/models"),
    ]
    
    print("=" * 60)
    print("Local LLM Provider Status")
    print("=" * 60)
    
    for name, url in providers:
        try:
            resp = requests.get(url, timeout=2)
            status = "✅ Running" if resp.status_code == 200 else f"⚠️ Status {resp.status_code}"
        except requests.exceptions.ConnectionError:
            status = "❌ Not running"
        except Exception as e:
            status = f"❌ Error: {e}"
        
        print(f"  {name:15} {status}")
    
    print()


if __name__ == "__main__":
    test_all_providers()
    print()
    test_fastflowlm()
