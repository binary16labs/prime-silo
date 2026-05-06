# Local LLM Setup Guide

**Configure Ollama, Lemonade, or FastFlowLM for local inference**

---

## Quick Start Options

| Provider       | Best For                        | Startup Command                     |
| -------------- | ------------------------------- | ----------------------------------- |
| **Ollama**     | General use, wide model support | `docker-compose up -d ollama`       |
| **LM Studio**   | Easy GUI, great for testing     | Start via Desktop app (port 1234)   |
| **Lemonade**   | AMD NPU acceleration            | `LemonadeServer.exe serve --port 13305` |
| **FastFlowLM** | Intel NPU acceleration          | Manual start on port 52625          |


---

## Option 1: Ollama (Recommended for Testing)

### Start with Docker

```bash
# Start Ollama container
docker-compose up -d ollama

# Pull a model
docker exec benny-ollama ollama pull llama3

# List available models
docker exec benny-ollama ollama list
```

### Start Natively (Windows)

```bash
# Install from https://ollama.ai
ollama serve

# Pull models
ollama pull llama3
ollama pull phi3
ollama pull gemma:7b
```

### API Endpoint

- **URL**: http://localhost:11434/v1
- **API Key**: `ollama` (dummy value for compatibility)

### Test Connection

```bash
curl http://localhost:11434/v1/models
```

---

## Option 2: Lemonade (AMD NPU)

For AMD Ryzen AI processors with NPU acceleration.

### Prerequisites

1. AMD Ryzen AI processor (7040 series or newer)
2. Lemonade SDK installed

### Start Server

```bash
LemonadeServer.exe serve --port 13305
```

### API Endpoint

- **URL**: http://localhost:13305/api/v1
- **API Key**: `not-needed`

### Test Connection

```bash
curl http://localhost:13305/api/v1/models
```

### Recommended Models

- `openai/Gemma-3-4b-it-FLM` - Fast, optimized for NPU
- `openai/Phi-3-mini-128k-instruct-FLM` - Good reasoning

---

## Option 3: FastFlowLM (Intel NPU) - Recommended for Testing

For Intel Core Ultra processors with NPU acceleration. Currently configured in dangpy as the default provider.

### Prerequisites

1. Intel Core Ultra processor with NPU
2. FastFlowLM installed and configured

### Default Configuration (from dangpy)

```json
{
  "provider": "fastflowlm",
  "model": "gemma3:4b",
  "port": 52625
}
```

### Start Server

FastFlowLM requires manual startup. Ensure it's running on port 52625.

### API Endpoint

- **URL**: http://localhost:52625/v1
- **API Key**: `not-needed`

### Recommended Models

| Model                      | Description                                     |
| -------------------------- | ----------------------------------------------- |
| `gemma3:4b`                | **Default** - Google Gemma 3 4B, fast inference |
| `openai/Gemma-3-4b-it-FLM` | Alternative naming for Lemonade compatibility   |

### Test Connection

```python
# Run the test script
python test_llm.py

# Or manually test with curl (PowerShell)
Invoke-RestMethod -Uri "http://localhost:52625/v1/models"
```

---

## Option 4: LM Studio (Desktop)

Popular GUI for running local LLMs on Windows/Mac/Linux.

### Prerequisites

1. Download LM Studio from [https://lmstudio.ai](https://lmstudio.ai)
2. Load a model (e.g., **Gemma 4**, Llama 3, etc.)
3. Start the "Local Server" inside LM Studio

### API Endpoint

- **URL**: http://localhost:1234/v1
- **API Key**: `not-needed`
- **Port**: 1234 (Default)

### Test Connection

```bash
curl http://localhost:1234/v1/models
```

---


## Configuration in Benny

### Python Configuration

```python
from benny.config import configure_local_provider

# Option 1: Lemonade (default)
configure_local_provider("lemonade", port=13305)

# Option 2: Ollama
configure_local_provider("ollama", port=11434)

# Option 3: FastFlowLM
configure_local_provider("fastflowlm", port=52625)

# Option 4: LM Studio
configure_local_provider("lmstudio", port=1234)

```

### Environment Variables

```bash
# For Ollama
export OPENAI_API_BASE=http://localhost:11434/v1
export OPENAI_API_KEY=ollama

# For Lemonade
export OPENAI_API_BASE=http://localhost:13305/api/v1
export OPENAI_API_KEY=not-needed

# For FastFlowLM
export OPENAI_API_BASE=http://localhost:52625/v1
export OPENAI_API_KEY=not-needed

# For LM Studio
export OPENAI_API_BASE=http://localhost:1234/v1
export OPENAI_API_KEY=not-needed

```

---

## Switching Between Providers

All three providers use OpenAI-compatible APIs, so switching is easy:

```python
# Just change the provider setting
settings = {
    "provider": "ollama",  # or "lemonade" or "fastflowlm"
    "port": 11434,
    "model": "llama3"
}
```

---

## Troubleshooting

### Ollama Not Responding

```bash
# Check if container is running
docker ps | grep ollama

# View logs
docker logs benny-ollama

# Restart
docker-compose restart ollama
```

### Lemonade Server Issues

```bash
# Check if port is in use
netstat -ano | findstr 13305

# Kill existing process and restart
taskkill /F /PID <pid>
LemonadeServer.exe serve --port 13305
```

### Model Not Found

```bash
# For Ollama - pull the model first
docker exec benny-ollama ollama pull <model_name>

# List available models
docker exec benny-ollama ollama list
```

---

## Performance Comparison

| Provider         | Latency         | Memory   | Best For         |
| ---------------- | --------------- | -------- | ---------------- |
| Ollama (CPU)     | ~2-5s/token     | 8-16GB   | General testing  |
| Ollama (GPU)     | ~50-100ms/token | 8GB VRAM | Production local |
| Lemonade (NPU)   | ~30-80ms/token  | Low      | AMD laptops      |
| FastFlowLM (NPU) | ~30-80ms/token  | Low      | Intel laptops    |
| LM Studio (GPU)  | ~30-100ms/token | 8GB VRAM | Desktop/NVIDIA   |


---

> **Version**: Benny v1.0  
> **Last Updated**: 2026-01-31
