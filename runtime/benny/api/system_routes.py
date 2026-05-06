from fastapi import APIRouter
from ..core.logging_service import system_logs

router = APIRouter()

@router.get("/logs")
async def get_system_logs(limit: int = 50):
    """Get recent system logs from the in-memory buffer."""
    logs = system_logs.get_logs()
    # Apply limit
    return {"logs": logs[-limit:]}

@router.get("/pulse")
async def get_pulse_status():
    """Aggregated status for the HUD pulse."""
    logs = system_logs.get_logs()
    return {
        "status": "online",
        "logCount": len(logs),
        "recent": logs[-5:] if logs else []
    }
