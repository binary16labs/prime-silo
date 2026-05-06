import requests
import json
import time

def test_fastflowlm_direct():
    print("Testing FastFlowLM connection via direct HTTP...")
    
    url = "http://localhost:52625/v1/chat/completions"
    
    # Test cases for model names
    test_models = [
        "gemma3:4b",          # Likely correct one
        "openai/gemma3:4b", 
        "custom",
        "default"
    ]

    for model_name in test_models:
        print(f"\n------------------------------------------------")
        print(f"Trying model name: '{model_name}'")
        print(f"URL: {url}")
        print(f"------------------------------------------------")
        
        payload = {
            "model": model_name,
            "messages": [
                {"role": "user", "content": "Hello, simply reply 'OK'."}
            ],
            "temperature": 0.1,
            "max_tokens": 10
        }
        
        try:
            start_time = time.time()
            response = requests.post(
                url, 
                json=payload,
                headers={"Content-Type": "application/json"},
                timeout=10
            )
            duration = time.time() - start_time
            
            print(f"Status Code: {response.status_code}")
            if response.status_code == 200:
                data = response.json()
                content = data['choices'][0]['message']['content']
                print("✅ SUCCESS!")
                print(f"Response: {content}")
                print(f"Duration: {duration:.2f}s")
                return  # Stop after first success
            else:
                print(f"❌ FAILED with status {response.status_code}")
                print(f"Response: {response.text}")
                
        except Exception as e:
            print(f"❌ CONNECTION ERROR: {str(e)}")

if __name__ == "__main__":
    test_fastflowlm_direct()
