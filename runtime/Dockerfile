# Benny — the deterministic FastAPI runtime (logic & execution tier).
#
# Build context is the runtime/ directory. Neo4j, Marquez, Phoenix, etc. are
# external services wired in via env (see ../docker-compose.yml). This image is
# the API only.
FROM python:3.11-slim

WORKDIR /app

# build-essential covers wheels without prebuilt binaries; curl for healthcheck.
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential curl \
    && rm -rf /var/lib/apt/lists/*

# Install deps first for layer caching, then the package.
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY . .
RUN pip install --no-cache-dir -e .

ENV PYTHONUNBUFFERED=1 \
    BENNY_HOME=/data/benny \
    NEO4J_URI=bolt://neo4j:7687 \
    NEO4J_USER=neo4j

# BENNY_AGENT_API_KEY must match the shell's value (ADR-003): AgentScopeMiddleware
# pins requests bearing this key to sandbox scope. NEO4J_PASSWORD / BENNY_HMAC_KEY
# / model keys are injected at runtime, never baked in.
EXPOSE 8005

VOLUME ["/data/benny"]

HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD curl -fsS http://localhost:8005/api/health || exit 1

CMD ["uvicorn", "benny.api.server:app", "--host", "0.0.0.0", "--port", "8005"]
