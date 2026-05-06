"""
ETL Routes - Staging and Conversion Pipeline
"""

from fastapi import APIRouter, UploadFile, File, HTTPException
from pathlib import Path
import shutil
from ..core.workspace import get_workspace_path
from ..core.extraction import extract_structured_text
from ..governance.lineage import track_file_conversion

router = APIRouter()

@router.post("/stage-and-convert")
async def stage_and_convert_file(
    file: UploadFile = File(...),
    workspace: str = "default"
):
    """Explicit ETL Pipeline Step: Upload a RAW file to staging, convert to markdown, output to data_in"""
    try:
        staging_dir = get_workspace_path(workspace, "staging")
        staging_dir.mkdir(parents=True, exist_ok=True)
        
        staged_path = staging_dir / file.filename
        
        with open(staged_path, "wb") as buffer:
            shutil.copyfileobj(file.file, buffer)
            
        # Parse it safely into UTF-8 text using Docling
        text = extract_structured_text(staged_path)
        
        markdown_filename = f"{staged_path.stem}.md"
        data_in_dir = get_workspace_path(workspace, "data_in")
        data_in_dir.mkdir(parents=True, exist_ok=True)
        md_out_path = data_in_dir / markdown_filename
        
        with open(md_out_path, "w", encoding="utf-8") as f:
            f.write(text)
            
        # Emit dataset transformation event to Marquez OpenLineage
        try:
            track_file_conversion(
                input_path=f"staging/{file.filename}",
                output_path=f"data_in/{markdown_filename}",
                workspace=workspace
            )
        except Exception as lineage_err:
            print(f"Warning: Failed to emit lineage for conversion: {lineage_err}")

        return {
            "status": "converted",
            "original_filename": file.filename,
            "markdown_filename": markdown_filename,
            "path": str(md_out_path),
            "size": md_out_path.stat().st_size
        }
        
    except Exception as e:
        raise HTTPException(500, f"Stage and convert failed: {str(e)}")
