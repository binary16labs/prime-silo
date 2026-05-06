"""
Data Processing Tools - PDF extraction and CSV querying
"""

from langchain_core.tools import tool
from pathlib import Path
import pandas as pd

from ..core.workspace import get_workspace_path, smart_output


@tool
async def extract_pdf_text(pdf_path: str, workspace: str = "default") -> str:
    """
    Extract text content from a PDF file.
    
    Args:
        pdf_path: Path to PDF file (relative to workspace/data_in)
        workspace: Workspace ID
        
    Returns:
        Extracted text content (pass-by-reference if >5KB)
    """
    try:
        import fitz  # PyMuPDF
        
        full_path = get_workspace_path(workspace, "data_in") / pdf_path
        
        if not full_path.exists():
            return f"[!] PDF not found: {pdf_path}"
        
        # Handle Directory
        if full_path.is_dir():
            pdf_files = list(full_path.glob("**/*.pdf"))
            print(f"DEBUG: Found {len(pdf_files)} PDFs in {full_path}", flush=True)
            import logging
            logging.getLogger(__name__).info(f"[SEC] Found {len(pdf_files)} PDFs in {full_path}")
            if not pdf_files:
                return f"[!] No PDF files found in directory: {pdf_path}"
            
            results = []
            for pf in pdf_files:
                # Use forward slashes for cross-platform consistency in paths
                rel_path = pf.relative_to(get_workspace_path(workspace, "data_in")).as_posix()
                results.append(await extract_pdf_text.func(pdf_path=rel_path, workspace=workspace))
            return "\n\n".join(results)

        doc = fitz.open(str(full_path))
        text_parts = []
        
        for page_num, page in enumerate(doc):
            text = page.get_text()
            if text.strip():
                text_parts.append(f"--- Page {page_num + 1} ---\n{text}")
                
        if not text_parts:
            # Try OCR
            import pytesseract
            from PIL import Image
            import io
            import sys
            
            if sys.platform == 'win32':
                pytesseract.pytesseract.tesseract_cmd = r'C:\Program Files\Tesseract-OCR\tesseract.exe'
                
            limit = min(25, len(doc))
            for i in range(limit):
                page = doc[i]
                pix = page.get_pixmap(matrix=fitz.Matrix(2, 2))
                img = Image.open(io.BytesIO(pix.tobytes("png")))
                ocr_text = pytesseract.image_to_string(img)
                if ocr_text.strip():
                    text_parts.append(f"--- Page {i + 1} (OCR) ---\n{ocr_text}")
        
        doc.close()
        
        if not text_parts:
            return f"❌ No text extracted from {pdf_path}"
        
        full_text = "\n\n".join(text_parts)
        output_name = Path(pdf_path).stem + "_extracted.txt"
        
        return smart_output(full_text, output_name, workspace)
        
    except ImportError:
        return "❌ PyMuPDF not installed. Run: pip install pymupdf"
    except Exception as e:
        return f"❌ PDF extraction error: {str(e)}"


@tool
def query_csv(
    csv_path: str,
    query: str,
    workspace: str = "default"
) -> str:
    """
    Query a CSV file using Pandas query syntax.
    
    Args:
        csv_path: Path to CSV file (relative to workspace/data_in)
        query: Pandas query string (e.g., "amount > 100" or "df.head(10)")
        workspace: Workspace ID
        
    Returns:
        Query results as formatted table
    """
    try:
        full_path = get_workspace_path(workspace, "data_in") / csv_path
        
        if not full_path.exists():
            return f"❌ CSV not found: {csv_path}"
        
        df = pd.read_csv(full_path)
        
        # If query starts with "df." treat as expression, else use query()
        if query.strip().startswith("df."):
            # Expression mode: df.head(), df.describe(), etc.
            result = eval(query, {"df": df, "pd": pd})
        else:
            # Query mode: column conditions
            result = df.query(query)
        
        # Format output
        if isinstance(result, pd.DataFrame):
            if len(result) > 50:
                output = f"Showing first 50 of {len(result)} rows:\n"
                output += result.head(50).to_markdown(index=False)
            else:
                output = result.to_markdown(index=False)
        else:
            output = str(result)
        
        return smart_output(output, "query_result.md", workspace)
        
    except Exception as e:
        return f"❌ CSV query error: {str(e)}"
