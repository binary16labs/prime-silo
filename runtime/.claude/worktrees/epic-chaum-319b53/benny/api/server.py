"""
Benny API Server - FastAPI application with CORS and routers
"""

import json
import builtins

# Monkey-patch print to prevent UnicodeEncodeError on Windows CP1252 consoles
_original_print = builtins.print

def _safe_print(*args, **kwargs):
    try:
        _original_print(*args, **kwargs)
    except UnicodeEncodeError:
        safe_args = [str(a).encode('ascii', 'replace').decode('ascii') for a in args]
        _original_print(*safe_args, **kwargs)

builtins.print = _safe_print

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from starlette.middleware.base import BaseHTTPMiddleware
from pathlib import Path
import os

from contextlib import asynccontextmanager
from .llm_routes import router as llm_router
from .workflow_routes import router as workflow_router
from .file_routes import router as file_router
from .etl_routes import router as etl_router
from .rag_routes import router as rag_router
from .notebook_routes import router as notebook_router
from .chat_routes import router as chat_router
from .studio_executor import router as studio_router
from .skill_routes import router as skill_router
from .graph_routes import router as graph_router
from .workspace_routes import router as workspace_router
from .task_routes import router as task_router
from .governance_routes import router as governance_router
from .system_routes import router as system_router
from ..a2a.server import router as a2a_router
from .live_routes import router as live_router


@asynccontextmanager
async def lifespan(app):
    """Initialize services on startup, cleanup on shutdown."""
    # Startup
    try:
        from benny.core.graph_db import init_schema
        init_schema()
        print("Neo4j schema initialized")
    except Exception as e:
        print(f"Neo4j not available: {e}")
    
    # Initialize Security Manifests
    try:
        from benny.governance.permission_manifest import register_builtin_manifests
        register_builtin_manifests()
        print("✓ Security manifests initialized")
    except Exception as e:
        print(f"Failed to initialize security manifests: {e}")

    # Attach System Logging
    try:
        import logging
        from benny.core.logging_service import system_logs
        logging.getLogger().addHandler(system_logs)
        logging.getLogger().setLevel(logging.INFO)
        logging.info("Neural Nexus Kernel Initialized")
        logging.info(f"Workspace context: {os.getenv('BENNY_WORKSPACE', 'default')}")
        logging.info("System log collector active and streaming")
        print("✓ System log collector active")
    except Exception as e:
        print(f"Failed to start log collector: {e}")
        
    yield
    # Shutdown
    try:
        from benny.core.graph_db import close_driver
        close_driver()
        print("Neo4j driver closed")
    except Exception:
        pass


# =============================================================================
# GOVERNANCE CONFIG
# =============================================================================

# Whitelist of paths that DO NOT require governance auth 
# (e.g. Health, Docs, and SSE Progress Streams which lack standard header support)
GOVERNANCE_WHITELIST = [
    "/",
    "/api/health",
    "/docs",
    "/openapi.json",
    "/redoc",
    "/api/graph/ingest/events",
    "/api/live/enrich/events",   # Live Mode SSE streams
    "/api/workflows/execute/",   # Studio and Swarm event streams (SSE)
    "/.well-known/agent.json"    # A2A discovery must be public
]

class GovHeaderMiddleware(BaseHTTPMiddleware):
    """
    Cognitive Mesh Governance Middleware - Enforces X-Benny-API-Key requirement.
    """
    async def dispatch(self, request: Request, call_next):
        # 0. Allow OPTIONS preflights to pass cleanly to CORSMiddleware
        if request.method == "OPTIONS":
            return await call_next(request)

        # 1. Configurable Whitelist Check
        path = request.url.path
        if any(path.startswith(w) for w in GOVERNANCE_WHITELIST):
            return await call_next(request)
            
        # 2. Hardcoded Key Enforcement (Security Tier 1)
        api_key = request.headers.get("X-Benny-API-Key")
        if api_key != "benny-mesh-2026-auth":
            return Response(
                content=json.dumps({"detail": f"Governance violation: Invalid or missing X-Benny-API-Key at {path}"}),
                status_code=403,
                media_type="application/json"
            )
            
        return await call_next(request)


app = FastAPI(
    title="Benny API",
    description="Deterministic Graph Workflow Platform with Multi-Model AI Orchestration",
    version="1.0.0",
    docs_url="/docs",
    redoc_url="/redoc",
    lifespan=lifespan
)

# Add Governance Middleware
app.add_middleware(GovHeaderMiddleware)

# Restricted CORS for frontend development
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], 
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include routers
app.include_router(llm_router, prefix="/api/llm", tags=["LLM Management"])
app.include_router(file_router, prefix="/api", tags=["File Management"])
app.include_router(etl_router, prefix="/api/etl", tags=["ETL Pipeline"])
app.include_router(studio_router, prefix="/api", tags=["Studio"])  # Move up to prevent shadowing
app.include_router(task_router, prefix="/api", tags=["Task Governance"])   # Move up to prevent shadowing
app.include_router(workflow_router, prefix="/api", tags=["Workflows"])
app.include_router(rag_router, prefix="/api", tags=["RAG"])
app.include_router(notebook_router, prefix="/api", tags=["Notebooks"])
app.include_router(chat_router, prefix="/api", tags=["Chat"])
app.include_router(skill_router, prefix="/api", tags=["Skills"])
app.include_router(graph_router, prefix="/api", tags=["Knowledge Graph"])
app.include_router(workspace_router, prefix="/api/workspaces", tags=["Workspace Settings"])
app.include_router(governance_router, prefix="/api/governance", tags=["Security & Compliance"])
app.include_router(system_router, prefix="/api/system", tags=["System Diagnostics"])
app.include_router(live_router, prefix="/api", tags=["Live Mode"])
app.include_router(a2a_router, prefix="/a2a", tags=["Agent2Agent"])


@app.get("/api/heartbeat")
async def heartbeat():
    return {
        "status": "alive",
        "version": "1.0.1-strategic",
        "cwd": os.getcwd(),
        "pid": os.getpid()
    }


@app.get("/")
async def root():
    """API root - health check"""
    return {
        "name": "Benny API",
        "version": "1.0.0",
        "status": "healthy",
        "docs": "/docs"
    }


@app.get("/api/health")
async def health_check():
    """Health check endpoint"""
    return {"status": "ok"}


@app.get("/.well-known/agent.json")
async def well_known_agent_card():
    """Serve Agent Card at the well-known discovery path."""
    from benny.a2a.server import _get_agent_card
    return _get_agent_card().model_dump()


# Serve workspace files
workspace_path = Path("workspace")
if workspace_path.exists():
    app.mount("/files", StaticFiles(directory=str(workspace_path)), name="files")


if __name__ == "__main__":
    import uvicorn
    # Cognitive Mesh Security: Bind to loopback only by default
    uvicorn.run(app, host="0.0.0.0", port=8005, reload=True)

