"""
File Routes - Upload, list, and manage workspace files
"""

from fastapi import APIRouter, UploadFile, File, HTTPException
from pydantic import BaseModel
from pathlib import Path
from typing import List
import shutil
import httpx
from bs4 import BeautifulSoup
from markdownify import markdownify as md
from ..governance.lineage import track_file_conversion
from ..core.extraction import extract_structured_text

from ..core.workspace import get_workspace_path, get_workspace_files


class UrlIngestRequest(BaseModel):
    url: str
    workspace: str = "default"

router = APIRouter()

@router.post("/files/download-url")
async def download_url(request: UrlIngestRequest):
    """Download content from a URL, parse HTML to Markdown, and save to data_in"""
    try:
        async with httpx.AsyncClient() as client:
            response = await client.get(request.url, follow_redirects=True, timeout=30.0)
            response.raise_for_status()
            
        content_type = response.headers.get("content-type", "").lower()
        target_dir = get_workspace_path(request.workspace, "data_in")
        target_dir.mkdir(parents=True, exist_ok=True)
        
        if "text/html" in content_type:
            soup = BeautifulSoup(response.text, "html.parser")
            title = soup.title.string if soup.title else "Downloaded Document"
            import re
            safe_title = re.sub(r'[^a-zA-Z0-9_\-]', '_', title).strip('_')
            if not safe_title:
                safe_title = "Downloaded_Document"
                
            # Convert HTML to Markdown using markdownify
            markdown_content = md(str(soup), heading_style="ATX")
            
            file_name = f"{safe_title}.md"
            file_path = target_dir / file_name
            
            with open(file_path, "w", encoding="utf-8") as f:
                f.write(markdown_content)
                
            return {
                "status": "downloaded",
                "filename": file_name,
                "path": str(file_path),
                "is_markdown": True
            }
        else:
            # Save raw file if not HTML
            file_name = request.url.split("/")[-1] or "downloaded_file.txt"
            if not any(file_name.lower().endswith(ext) for ext in ['.txt', '.md', '.pdf']):
                file_name += ".txt"
                
            file_path = target_dir / file_name
            with open(file_path, "wb") as f:
                f.write(response.content)
                
            return {
                "status": "downloaded",
                "filename": file_name,
                "path": str(file_path),
                "is_markdown": False
            }
    except Exception as e:
        raise HTTPException(500, f"URL download failed: {str(e)}")

@router.post("/files/download-gutenberg")
async def download_gutenberg(request: UrlIngestRequest):
    """Download a TXT from Gutenberg, extract Title and save as Markdown"""
    try:
        async with httpx.AsyncClient() as client:
            response = await client.get(request.url, follow_redirects=True, timeout=30.0)
            response.raise_for_status()
            
        text = response.text
        
        # Look for the Title in Gutenberg txt format, e.g., "Title: The Dog\r\n"
        import re
        match = re.search(r"Title:\s*([^\r\n]+)", text)
        title = match.group(1).strip() if match else "Gutenberg_Book"
        
        safe_title = re.sub(r'[^a-zA-Z0-9_\-]', '_', title).strip('_')
        if not safe_title:
            safe_title = "Gutenberg_Book"
            
        target_dir = get_workspace_path(request.workspace, "data_in")
        target_dir.mkdir(parents=True, exist_ok=True)
        
        file_name = f"{safe_title}.md"
        file_path = target_dir / file_name
        
        with open(file_path, "w", encoding="utf-8") as f:
            f.write(f"# {title}\n\n{text}")
            
        return {
            "status": "downloaded",
            "filename": file_name,
            "path": str(file_path),
            "is_markdown": True
        }
    except Exception as e:
        raise HTTPException(500, f"Gutenberg download failed: {str(e)}")


@router.post("/files/upload")
async def upload_file(
    file: UploadFile = File(...),
    workspace: str = "default",
    subdir: str = "data_in"
):
    """Upload a file to workspace data_in directory"""
    try:
        # Validate file type
        allowed_extensions = {'.pdf', '.txt', '.md', '.json'}
        file_ext = Path(file.filename).suffix.lower()
        
        if file_ext not in allowed_extensions:
            raise HTTPException(
                400, 
                f"File type {file_ext} not allowed. Allowed: {', '.join(allowed_extensions)}"
            )
        
        # Save file
        target_dir = get_workspace_path(workspace, subdir)
        target_dir.mkdir(parents=True, exist_ok=True)
        
        file_path = target_dir / file.filename
        
        with open(file_path, "wb") as buffer:
            shutil.copyfileobj(file.file, buffer)
        
        # Emit lineage for non-PDF uploads (PDFs go through /api/etl/stage-and-convert which has its own tracking)
        try:
            track_file_conversion(
                input_path=f"upload/{file.filename}",
                output_path=f"{subdir}/{file.filename}",
                workspace=workspace,
                job_name="file_upload"
            )
        except Exception as lineage_err:
            print(f"Warning: Failed to emit lineage for upload: {lineage_err}")

        return {
            "status": "uploaded",
            "filename": file.filename,
            "path": str(file_path),
            "size": file_path.stat().st_size
        }
        
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"Upload failed: {str(e)}")



@router.get("/files")
async def list_files(workspace: str = "default"):
    """List all files in workspace data_in, data_out, and staging"""
    try:
        staging_files = get_workspace_files(workspace, "staging")
        data_in_files = get_workspace_files(workspace, "data_in")
        data_out_files = get_workspace_files(workspace, "data_out")
        
        return {
            "workspace": workspace,
            "staging": staging_files,
            "data_in": data_in_files,
            "data_out": data_out_files,
            "total": len(data_in_files) + len(data_out_files) + len(staging_files)
        }
    except Exception as e:
        raise HTTPException(500, f"Failed to list files: {str(e)}")


@router.get("/files/recursive-scan")
async def recursive_scan(workspace: str = "default"):
    """Recursively scan the entire workspace directory including hidden files."""
    try:
        base_dir = get_workspace_path(workspace)
        if not base_dir.exists():
            raise HTTPException(404, f"Workspace {workspace} not found")
        
        all_files = []
        import os
        from ..core.workspace import WORKSPACE_ROOT
        
        for root, dirs, files in os.walk(base_dir):
            for name in files:
                file_path = Path(root) / name
                try:
                    rel_path = file_path.relative_to(base_dir)
                    all_files.append({
                        "name": name,
                        "path": str(rel_path),
                        "full_path": str(file_path.relative_to(WORKSPACE_ROOT.absolute())),
                        "size": file_path.stat().st_size,
                        "modified": file_path.stat().st_mtime,
                        "type": file_path.suffix.lower().lstrip('.') or "unknown",
                        "is_hidden": name.startswith('.')
                    })
                except Exception:
                    continue
                    
        return {
            "workspace": workspace,
            "files": all_files,
            "total": len(all_files)
        }
    except Exception as e:
        raise HTTPException(500, f"Recursive scan failed: {str(e)}")


@router.get("/files/preview")
async def preview_file(path: str, workspace: str = "default"):
    """Get content preview or metadata based on file type."""
    try:
        # Security: validate path is within workspace
        file_path = get_workspace_path(workspace) / path
        if not file_path.exists():
            raise HTTPException(404, "File not found")
            
        ext = file_path.suffix.lower()
        
        # Metadata
        stat = file_path.stat()
        res = {
            "name": file_path.name,
            "size": stat.st_size,
            "modified": stat.st_mtime,
            "extension": ext.lstrip('.')
        }
        
        # Content handling
        if ext in ['.md', '.txt', '.json', '.py', '.ts', '.tsx', '.css', '.html', '.yaml', '.yml']:
            try:
                content = file_path.read_text(encoding="utf-8")
                res["content"] = content
                res["format"] = "text"
            except Exception as e:
                res["content"] = f"Error reading text content: {str(e)}"
                res["format"] = "error"
        elif ext == '.pdf':
            # PDFs are handled as blobs in the browser usually, 
            # but we can return the URL for the static file server
            res["format"] = "pdf"
            res["url"] = f"/api/static/{workspace}/{path}"
        else:
            res["format"] = "binary"
            res["url"] = f"/api/static/{workspace}/{path}"
            
        return res
    except Exception as e:
        raise HTTPException(500, f"Preview failed: {str(e)}")


@router.delete("/files/{filename}")
async def delete_file(
    filename: str,
    workspace: str = "default",
    subdir: str = "data_in"
):
    """Delete a file from workspace"""
    try:
        # Handle recursive paths if filename contains slashes
        file_path = get_workspace_path(workspace, subdir) / filename
        
        if not file_path.exists():
            raise HTTPException(404, f"File not found: {filename}")
        
        if not file_path.is_file():
            raise HTTPException(400, f"Not a file: {filename}")
        
        file_path.unlink()
        
        return {
            "status": "deleted",
            "filename": filename
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"Delete failed: {str(e)}")
