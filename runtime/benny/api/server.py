"""
Benny API Server - FastAPI application with CORS and routers
"""

import os as _os
from pathlib import Path as _Path

# Load repo-root .env so a background/service uvicorn (which does NOT inherit a
# terminal's transient $env vars) still picks up pinned overrides such as
# BENNY_LMSTUDIO_ENDPOINTS / BENNY_DEFAULT_MODEL. override=True so the .env pin
# wins over any stale value a tray/desktop launcher may have exported into this
# process tree — the whole point of the file is to be authoritative.
_ENV_PATH = _Path(__file__).resolve().parent.parent.parent.parent / ".env"
try:
    import dotenv as _dotenv

    _dotenv.load_dotenv(_ENV_PATH, override=True)
except ImportError:
    # In a frozen/bundled runtime python-dotenv may be absent. Fail loud (not
    # silent) so a missing .env-load is diagnosable instead of silently
    # reproducing the "endpoints not applied" bug.
    import logging as _logging

    _logging.getLogger(__name__).warning(
        "python-dotenv not installed — %s was NOT loaded; env-var overrides "
        "(BENNY_LMSTUDIO_ENDPOINTS, BENNY_DEFAULT_MODEL) must be set in the "
        "process environment instead.",
        _ENV_PATH,
    )

# ─── Windows aiohttp SSL hang fix ─────────────────────────────────────────────
# aiohttp's connector.py calls ssl.SSLContext.set_default_verify_paths() at
# import time, which can hang indefinitely on Windows during Uvicorn's
# reloader child-process spawn.  Point SSL_CERT_FILE at certifi's bundle
# (if installed) so the slow OS-level CA discovery is skipped entirely.
if not _os.environ.get("SSL_CERT_FILE"):
    try:
        import certifi as _certifi

        _os.environ["SSL_CERT_FILE"] = _certifi.where()
    except ImportError:
        pass  # certifi not installed; fall through to OS defaults

import asyncio as _asyncio
import builtins
import sys as _sys

# Monkey-patch print to prevent UnicodeEncodeError on Windows CP1252 consoles
_original_print = builtins.print


def _safe_print(*args, **kwargs):
    try:
        _original_print(*args, **kwargs)
    except UnicodeEncodeError:
        # Replace non-encodable characters with '?' for console stability
        safe_args = [str(a).encode("ascii", "replace").decode("ascii") for a in args]
        _original_print(*safe_args, **kwargs)


builtins.print = _safe_print

# ─── Windows FD-limit fix ─────────────────────────────────────────────────────
if _sys.platform == "win32":
    try:
        # Increase the C runtime's max files limit if supported
        import msvcrt

        if hasattr(msvcrt, "setmaxstdio"):
            msvcrt.setmaxstdio(2048)

        # Force ProactorEventLoopPolicy for this process
        _asyncio.set_event_loop_policy(_asyncio.WindowsProactorEventLoopPolicy())
        print("✓ Windows ProactorEventLoopPolicy Enforced (IOCP)")
    except Exception as e:
        print(f"Warning: Failed to enforce ProactorEventLoop: {e}")

from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from starlette.middleware.base import BaseHTTPMiddleware

from ..a2a.server import router as a2a_router
from .agent_sandbox_routes import router as agent_sandbox_router
from .agent_scope import AgentScopeMiddleware, resolve_benny_api_key
from .agentamp_routes import router as agentamp_router
from .audio_routes import router as audio_router
from .chat_routes import router as chat_router
from .checkpoint_routes import pinned_router as checkpoint_pinned_router
from .checkpoint_routes import sandbox_router as checkpoint_sandbox_router
from .deep_produce_routes import router as deep_produce_router
from .etl_routes import router as etl_router
from .file_routes import router as file_router
from .governance_routes import router as governance_router
from .graph_routes import router as graph_router
from .kg3d import router as kg3d_router
from .live_routes import router as live_router
from .llm_routes import router as llm_router
from .manifest_routes import router as manifest_router
from .notebook_routes import router as notebook_router
from .offload_routes import router as offload_router
from .opencode_routes import router as opencode_router
from .ops_endpoints import router as ops_router
from .pypes_routes import router as pypes_router
from .rag_routes import router as rag_router
from .skill_routes import router as skill_router
from .studio_executor import router as studio_router
from .system_routes import router as system_router
from .task_routes import router as task_router
from .views_routes import router as views_router
from .vision_routes import router as vision_router
from .widget_routes import router as widget_router
from .workflow_endpoints import router as workflow_endpoints_router
from .workflow_routes import router as workflow_router
from .workspace_routes import router as workspace_router

# Temporary fix for missing rbac.py module
GOVERNANCE_WHITELIST = ["/api/health", "/api/status"]
from ..core.workspace import get_workspace_path

# Q0: the canonical resolver lives in agent_scope (light imports, so the
# key-resolution tests never have to pull in the whole route tree).
_resolve_benny_api_key = resolve_benny_api_key


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup: Initialize shared resources
    loop = _asyncio.get_running_loop()
    loop_type = type(loop).__name__
    print(f"✓ Neural Nexus Kernel Initialized (Loop: {loop_type})")

    # Load this install's signing key into the environment so view/pin/.aamp
    # signatures use the per-install key (generated by `benny init` at
    # $BENNY_HOME/state/hmac-key) instead of the shared dev fallback. An
    # explicit BENNY_HMAC_KEY always wins.
    _benny_home = _os.environ.get("BENNY_HOME")
    if _benny_home:
        try:
            from ..portable.home import ensure_hmac_key_in_env

            if ensure_hmac_key_in_env(Path(_benny_home)):
                print("✓ Per-install signing key loaded from $BENNY_HOME/state/hmac-key")
        except Exception as exc:  # never block startup on key loading
            print(f"⚠ Could not load per-install signing key: {exc}")

    if _sys.platform == "win32" and loop_type == "SelectorEventLoop":
        print(
            "⚠ WARNING: Server is running on SelectorEventLoop on Windows. "
            "File descriptor errors may occur under load."
        )

    yield
    # Shutdown: Clean up
    print("Neo4j driver closed")


app = FastAPI(
    title="Benny Neural Nexus API",
    description="Cognitive Mesh Engine for Software Synthesis",
    version="1.0.0",
    lifespan=lifespan,
)


# Governance Middleware (FR-5: RBAC Enforcement)
class GovernanceMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        # 1. Path Whitelist (Health, SSE, Docs)
        path = request.url.path
        if path == "/" or path.startswith("/docs") or path.startswith("/openapi.json"):
            return await call_next(request)

        for white_path in GOVERNANCE_WHITELIST:
            if path.startswith(white_path):
                return await call_next(request)

        # 2. Extract API Key
        api_key = request.headers.get("X-Benny-API-Key")
        if not api_key:
            return Response(
                content='{"detail":"Unauthorized: X-Benny-API-Key required"}',
                status_code=401,
                media_type="application/json",
            )

        # 3. RBAC Check (PBR-001 Phase 3)
        # Simplified for now: just check if key exists. Full implementation in Phase 8.
        try:
            expected_key = _resolve_benny_api_key()
        except RuntimeError as exc:
            return Response(
                content=f'{{"detail":"Server misconfigured: {exc}"}}',
                status_code=500,
                media_type="application/json",
            )
        if api_key != expected_key:
            return Response(
                content='{"detail":"Forbidden: Invalid API Key"}',
                status_code=403,
                media_type="application/json",
            )

        return await call_next(request)


# app.add_middleware(GovernanceMiddleware)

# ADR-001: Agent scope guard — restricts X-Benny-Agent-Scope=sandbox writes
# to /api/agent_sandbox/. Reads are unrestricted for agent scopes; human
# (unscoped) traffic falls through to GovernanceMiddleware untouched.
app.add_middleware(AgentScopeMiddleware)

# Enable CORS for Benny Studio (UX-REC-001)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # In production, restrict to studio domain
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Register Routers
app.include_router(system_router, prefix="/api/system", tags=["System"])
app.include_router(llm_router, prefix="/api/llm", tags=["LLM"])
app.include_router(workspace_router, prefix="/api/workspaces", tags=["Workspaces"])
app.include_router(file_router, prefix="/api/files", tags=["Files"])
app.include_router(etl_router, prefix="/api/etl", tags=["ETL"])
app.include_router(rag_router, prefix="/api", tags=["RAG"])
app.include_router(vision_router, prefix="/api/vision", tags=["Vision"])
app.include_router(graph_router, prefix="/api", tags=["Knowledge Graph"])
app.include_router(notebook_router, prefix="/api/notebooks", tags=["Notebooks"])
app.include_router(chat_router, prefix="/api/chat", tags=["Chat"])
app.include_router(offload_router, prefix="/api/offload", tags=["Offload"])
app.include_router(studio_router, prefix="/api/workflows/studio", tags=["Studio"])
app.include_router(workflow_router, prefix="/api/workflows", tags=["Workflows"])
app.include_router(workflow_endpoints_router, prefix="/api/workflows", tags=["Workflows"])
app.include_router(skill_router, prefix="/api/skills", tags=["Skills"])
app.include_router(task_router, prefix="/api/tasks", tags=["Tasks"])
app.include_router(governance_router, prefix="/api/governance", tags=["Governance"])
app.include_router(live_router, prefix="/api/live", tags=["Live"])
app.include_router(manifest_router, prefix="/api/manifests", tags=["Manifests"])
app.include_router(deep_produce_router, prefix="/api", tags=["DeepProduce"])
app.include_router(opencode_router, prefix="/api/opencode", tags=["Opencode"])
app.include_router(a2a_router, prefix="/a2a", tags=["A2A"])
app.include_router(audio_router, prefix="/api/audio", tags=["Audio"])
app.include_router(ops_router, prefix="/api/ops", tags=["Ops"])
app.include_router(kg3d_router, tags=["KG3D"])
app.include_router(pypes_router, prefix="/api/pypes", tags=["Pypes"])
app.include_router(agentamp_router, prefix="/api", tags=["AgentAmp"])
# ADR-001: Single chokepoint for agent-authored writes. AgentScopeMiddleware
# rejects mutating requests from X-Benny-Agent-Scope=sandbox callers that do
# not target this prefix.
app.include_router(agent_sandbox_router, prefix="/api/agent_sandbox", tags=["AgentSandbox"])
# ADR-001 Phase F: HMAC-SHA256 sign/verify for `.aamp.view` layouts. Mounted
# OUTSIDE the agent_sandbox prefix so AgentScopeMiddleware blocks every
# agent-scoped POST here with a 403 — pinning is a human action.
app.include_router(views_router, prefix="/api/views", tags=["Views"])
# ADR-001 Phase H: Session checkpoint draft operations. Mounted under the
# agent_sandbox prefix so AgentScopeMiddleware allows scoped agent writes.
app.include_router(
    checkpoint_sandbox_router, prefix="/api/agent_sandbox/checkpoints", tags=["Checkpoints"]
)
# ADR-001 Phase H: Pinned checkpoint operations (pin / load / list).
# Mounted OUTSIDE agent_sandbox so AgentScopeMiddleware blocks agent POSTs.
app.include_router(checkpoint_pinned_router, prefix="/api/checkpoints", tags=["Checkpoints"])
# ADR-001: Widget registry — typed contract describing which canvases the
# agent (and the frontend) may compose into a Review-zone layout.
app.include_router(widget_router, prefix="/api/widgets", tags=["Widgets"])


@app.get("/")
async def root():
    return {
        "app": "Benny Neural Nexus",
        "status": "online",
        "mesh_version": "2026.4.1",
        "engine": "Synthesis Knowledge Engine v2",
    }


# Lightweight, auth-free liveness probe. Already in GOVERNANCE_WHITELIST above,
# so it bypasses the API-key middleware. The desktop shell's runtime supervisor,
# tray status poll, and services.probeBennyRuntime all GET /api/health to decide
# whether the bundled Benny is up — keep this cheap and dependency-free (must NOT
# touch Neo4j/Chroma so it answers immediately during cold start).
@app.get("/api/health")
async def health():
    return {"status": "ok"}


@app.get("/api/status")
async def status():
    return {"status": "ok", "app": "benny"}


# Static file serving for workspace data_out artifacts
# Note: workspace_path is resolved at runtime based on BENNY_HOME
workspace_path = get_workspace_path("default").parent
workspace_path.mkdir(parents=True, exist_ok=True)
app.mount("/api/static", StaticFiles(directory=str(workspace_path)), name="files")


if __name__ == "__main__":
    import uvicorn

    # Cognitive Mesh Security: Bind to loopback only by default (Q0). Set
    # BENNY_API_HOST=0.0.0.0 explicitly to expose this dev server on the LAN.
    # Note: Use string import for better reload stability on Windows
    _dev_host = _os.environ.get("BENNY_API_HOST", "127.0.0.1")
    uvicorn.run("benny.api.server:app", host=_dev_host, port=8005, reload=True, loop="asyncio")
