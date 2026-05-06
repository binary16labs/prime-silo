# Marquez & Observability Setup Guide

**Complete guide for setting up Marquez (OpenLineage), Phoenix (Tracing), and N8N (Workflows)**

---

## Quick Start

```bash
# Start all services
docker-compose up -d

# Verify services are running
docker-compose ps

# View logs
docker-compose logs -f marquez-api
```

---

## Service URLs

| Service         | URL                   | Purpose                     |
| --------------- | --------------------- | --------------------------- |
| **Marquez API** | http://localhost:5000 | OpenLineage event collector |
| **Marquez UI**  | http://localhost:3001 | Lineage visualization       |
| **Phoenix**     | http://localhost:6006 | Distributed tracing UI      |
| **N8N**         | http://localhost:5678 | Workflow orchestration      |

---

## Architecture

```
┌────────────────────────────────────────────────────────────────┐
│                        Benny Platform                          │
│                                                                │
│  ┌──────────┐      ┌──────────────┐      ┌──────────────┐     │
│  │ Your App │─────▶│ Marquez API  │◀────▶│ PostgreSQL   │     │
│  │          │      │ (port 5000)  │      │ (marquez-db) │     │
│  └──────────┘      └──────────────┘      └──────────────┘     │
│       │                   │                                    │
│       │            ┌──────────────┐                           │
│       │            │ Marquez Web  │                           │
│       │            │ (port 3001)  │                           │
│       │            └──────────────┘                           │
│       │                                                        │
│       ▼                                                        │
│  ┌──────────────┐                                             │
│  │   Phoenix    │                                             │
│  │ (port 6006)  │                                             │
│  └──────────────┘                                             │
└────────────────────────────────────────────────────────────────┘
```

---

## Verifying Marquez Setup

### 1. Check API Health

```bash
curl http://localhost:5000/api/v1/namespaces
```

Expected response:

```json
{ "namespaces": [] }
```

### 2. Create a Namespace

```bash
curl -X PUT http://localhost:5000/api/v1/namespaces/benny \
  -H "Content-Type: application/json" \
  -d '{"ownerName": "benny_team", "description": "Benny workflow namespace"}'
```

### 3. Send a Test OpenLineage Event

```bash
curl -X POST http://localhost:5000/api/v1/lineage \
  -H "Content-Type: application/json" \
  -d '{
    "eventType": "START",
    "eventTime": "2026-01-31T21:00:00.000Z",
    "run": {
      "runId": "test-run-001"
    },
    "job": {
      "namespace": "benny",
      "name": "test_workflow"
    },
    "producer": "benny-platform",
    "inputs": [],
    "outputs": []
  }'
```

### 4. View in Marquez UI

1. Navigate to http://localhost:3001
2. Select "benny" namespace
3. You should see `test_workflow` job

---

## Python Integration

### Install Dependencies

```bash
pip install openlineage-python requests
```

### MarquezClient Implementation

```python
"""
Marquez Client for OpenLineage Event Emission
"""

import requests
import logging
from typing import Dict, Optional
from datetime import datetime

logger = logging.getLogger(__name__)


class MarquezClient:
    """Client for interacting with Marquez OpenLineage API."""

    def __init__(self, base_url: str = "http://localhost:5000"):
        self.base_url = base_url.rstrip('/')
        self.lineage_endpoint = f"{self.base_url}/api/v1/lineage"
        self._is_available = None
        self._last_check = None

    def is_available(self, cache_seconds: int = 30) -> bool:
        """Check if Marquez is available."""
        now = datetime.now()

        if self._last_check and self._is_available is not None:
            elapsed = (now - self._last_check).total_seconds()
            if elapsed < cache_seconds:
                return self._is_available

        try:
            response = requests.get(
                f"{self.base_url}/api/v1/namespaces",
                timeout=2
            )
            self._is_available = response.status_code == 200
        except Exception as e:
            logger.debug(f"Marquez not available: {e}")
            self._is_available = False

        self._last_check = now
        return self._is_available

    def emit_event(self, event: Dict) -> bool:
        """Emit an OpenLineage event to Marquez."""
        if not self.is_available():
            logger.debug("Marquez not available, skipping event emission")
            return False

        try:
            response = requests.post(
                self.lineage_endpoint,
                json=event,
                headers={"Content-Type": "application/json"},
                timeout=5
            )

            if response.status_code in (200, 201):
                logger.debug(f"Event sent: {event.get('job', {}).get('name')}")
                return True
            else:
                logger.warning(f"Marquez returned {response.status_code}")
                return False

        except requests.exceptions.Timeout:
            logger.warning("Timeout sending event to Marquez")
            return False
        except Exception as e:
            logger.warning(f"Error sending event: {e}")
            return False

    def get_lineage_url(self, workflow_id: str, namespace: str = "benny") -> str:
        """Get the Marquez UI URL for a workflow."""
        ui_base = self.base_url.replace(':5000', ':3001')
        return f"{ui_base}/lineage/{namespace}"
```

### Usage Example

```python
from marquez_client import MarquezClient
from uuid import uuid4
from datetime import datetime

client = MarquezClient("http://localhost:5000")

# Start event
start_event = {
    "eventType": "START",
    "eventTime": datetime.utcnow().isoformat() + "Z",
    "run": {"runId": str(uuid4())},
    "job": {
        "namespace": "benny",
        "name": "report_generation"
    },
    "producer": "benny-platform",
    "inputs": [
        {
            "namespace": "benny",
            "name": "documents/report.pdf"
        }
    ],
    "outputs": []
}

client.emit_event(start_event)

# ... do work ...

# Complete event
complete_event = {
    **start_event,
    "eventType": "COMPLETE",
    "outputs": [
        {
            "namespace": "benny",
            "name": "outputs/final_report.md"
        }
    ]
}

client.emit_event(complete_event)
```

---

## Troubleshooting

### Marquez API Not Starting

```bash
# Check logs
docker-compose logs marquez-api

# Common issue: PostgreSQL not ready
docker-compose restart marquez-api
```

### Database Connection Issues

```bash
# Verify PostgreSQL is healthy
docker-compose ps marquez-db

# Check database connectivity
docker exec -it benny-marquez-db psql -U marquez -d marquez -c "SELECT 1"
```

### Port Conflicts

If ports are in use, modify `docker-compose.yml`:

```yaml
ports:
  - "5002:5000" # Change left side (host port)
```

---

## Data Persistence

Data is persisted in Docker volumes:

| Volume             | Purpose                           |
| ------------------ | --------------------------------- |
| `benny-marquez-db` | PostgreSQL data (lineage history) |
| `benny-n8n`        | N8N workflow configurations       |

### Backup Marquez Data

```bash
docker exec benny-marquez-db pg_dump -U marquez marquez > marquez_backup.sql
```

### Restore Marquez Data

```bash
cat marquez_backup.sql | docker exec -i benny-marquez-db psql -U marquez marquez
```

---

## Next Steps

1. ✅ Start services: `docker-compose up -d`
2. ✅ Verify Marquez: http://localhost:3001
3. ✅ Verify Phoenix: http://localhost:6006
4. 🔜 Integrate MarquezClient in your application
5. 🔜 Add OpenLineage events to workflows

---

> **Version**: Benny v1.0  
> **Last Updated**: 2026-01-31
