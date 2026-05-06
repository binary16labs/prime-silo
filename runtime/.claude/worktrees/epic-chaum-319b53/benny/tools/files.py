"""
File Tools - Read/write files with workspace scoping
"""

from langchain.tools import tool
from pathlib import Path
from typing import List

from ..core.workspace import get_workspace_path, smart_output, get_workspace_files


@tool
def write_file(
    filename: str, 
    content: str, 
    workspace: str = "default",
    subdir: str = "data_out"
) -> str:
    """
    Write content to a file in the workspace.
    
    Args:
        filename: Target filename
        content: Content to write
        workspace: Workspace ID
        subdir: Subdirectory (default: data_out)
        
    Returns:
        Confirmation with download URL
    """
    try:
        path = get_workspace_path(workspace, subdir) / filename
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding='utf-8')
        
        return (
            f"✅ Written to {filename}\n"
            f"📥 Download: http://localhost:8005/api/files/{workspace}/{subdir}/{filename}"
        )
    except Exception as e:
        return f"❌ Write error: {str(e)}"


@tool
def read_file(
    filename: str, 
    workspace: str = "default",
    subdir: str = "data_in",
    encoding: str = None
) -> str:
    """
    Read a file from the workspace. Handles multiple encodings (UTF-8, UTF-16LE, etc.).
    
    Args:
        filename: File to read
        workspace: Workspace ID
        subdir: Subdirectory to look in (default: data_in)
        encoding: Optional explicit encoding (e.g. 'utf-16le')
        
    Returns:
        File content (pass-by-reference if >5KB)
    """
    import charset_normalizer
    
    try:
        path = get_workspace_path(workspace, subdir) / filename
        
        if not path.exists():
            # Try data_out if not in data_in
            alt_path = get_workspace_path(workspace, "data_out") / filename
            if alt_path.exists():
                path = alt_path
            else:
                return f"❌ File not found: {filename}"
        
        # Robust reading
        raw_bytes = path.read_bytes()
        
        if encoding:
            try:
                content = raw_bytes.decode(encoding)
            except Exception as e:
                return f"❌ Error decoding with explicit encoding {encoding}: {str(e)}"
        else:
            # Detect encoding
            results = charset_normalizer.from_bytes(raw_bytes)
            best_match = results.best()
            
            if best_match and best_match.encoding:
                content = str(best_match)
            else:
                # Fallback to UTF-8 with replacement for corrupted chars
                content = raw_bytes.decode('utf-8', errors='replace')
        
        # Normalize: Strip BOM and ensure clean UTF-8 for model consumption
        content = content.lstrip('\ufeff')
        
        return smart_output(content, f"{filename}_read.txt", workspace)
        
    except Exception as e:
        return f"❌ Read error: {str(e)}"


@tool
def list_files(workspace: str = "default", subdir: str = "data_out") -> str:
    """
    List files in a workspace directory.
    
    Args:
        workspace: Workspace ID
        subdir: Subdirectory to list (data_in, data_out, reports)
        
    Returns:
        List of files with sizes
    """
    try:
        files = get_workspace_files(workspace, subdir)
        
        if not files:
            return f"📂 No files in {workspace}/{subdir}"
        
        output_lines = [f"📂 Files in {workspace}/{subdir}:\n"]
        for f in files:
            size_kb = f['size'] / 1024
            output_lines.append(f"  • {f['name']} ({size_kb:.1f} KB)")
        
        return "\n".join(output_lines)
        
    except Exception as e:
        return f"❌ List error: {str(e)}"
