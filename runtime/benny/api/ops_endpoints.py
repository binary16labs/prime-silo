"""
Operations API Endpoints (Phase 6).
"""
from fastapi import APIRouter
from benny.ops.doctor import run_doctor

router = APIRouter(prefix="/api/ops", tags=["Ops"])

@router.get("/doctor")
async def get_doctor_report():
    """Run health diagnostics and return the report as JSON."""
    report = await run_doctor()
    return {
        "status_code": report.status_code,
        "checks": [
            {
                "name": c.name,
                "status": c.status,
                "message": c.message
            }
            for c in report.checks
        ]
    }
