"""
Extraction Utility - Structured document parsing using Docling
"""

import os
from pathlib import Path
from typing import Optional, List, Callable
import logging

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Basic fallback extractor (matches original rag_routes.py logic)
def _basic_extract(file_path: Path) -> str:
    ext = file_path.suffix.lower()
    if ext in ('.txt', '.md'):
        return file_path.read_text(encoding='utf-8')
    elif ext == '.pdf':
        import fitz
        doc = fitz.open(file_path)
        text = ""
        for page in doc:
            text += page.get_text()
        doc.close()
        return text
    else:
        raise ValueError(f"Unsupported file type for basic extraction: {ext}")


def extract_structured_text(file_path: Path, log_fn: Callable = print) -> str:
    """
    Extract high-quality structured Markdown from a document using Docling.
    Falls back to basic text extraction if Docling is unavailable or fails.
    """
    ext = file_path.suffix.lower()
    
    # Check if we should use Docling (PDF, DOCX, HTML, etc.)
    # Simple text/md files don't necessarily need Docling's heavy processing
    if ext in ('.txt', '.md'):
        try:
            return file_path.read_text(encoding='utf-8')
        except Exception as e:
            log_fn(f"Warning: Failed to read {file_path.name} as UTF-8: {e}")
    
    # Force basic extraction to avoid Docling deadlock/hang
    return _basic_extract(file_path)

    try:
        # log_fn(f"[INFO] Using Docling (PyPdfium Backend) to extract structured content from {file_path.name}...")
        from docling.document_converter import DocumentConverter, PdfFormatOption
        from docling.datamodel.base_models import InputFormat
        from docling.datamodel.pipeline_options import PdfPipelineOptions
        from docling.backend.pypdfium2_backend import PyPdfiumDocumentBackend
        
        # Optimize for memory (std::bad_alloc fix)
        pipeline_options = PdfPipelineOptions()
        pipeline_options.do_ocr = False # Faster and lighter if PDF has text; handles pages one-by-one.
        pipeline_options.do_table_structure = False # Disabled to prevent massive RAM spikes on complex PDFs
        
        converter = DocumentConverter(
            format_options={
                InputFormat.PDF: PdfFormatOption(
                    pipeline_options=pipeline_options,
                    backend=PyPdfiumDocumentBackend
                )
            }
        )
        
        result = converter.convert(str(file_path))
        
        # Docling provides high-quality Markdown which is perfect for LLM triple extraction
        markdown_content = result.document.export_to_markdown()
        
        if not markdown_content.strip():
            log_fn(f"[WARNING] Docling returned empty content for {file_path.name}. Falling back...")
            return _basic_extract(file_path)
            
        log_fn(f"[SUCCESS] Extracted {len(markdown_content)} characters of structured Markdown.")
        return markdown_content
        
    except ImportError as e:
        log_fn(f"[WARNING] Docling or backend not found ({e}). Using basic extraction fallback.")
        return _basic_extract(file_path)
    except Exception as e:
        log_fn(f"[WARNING] Docling extraction failed for {file_path.name}: {e}. Using fallback.")
        try:
            return _basic_extract(file_path)
        except Exception as fallback_err:
            log_fn(f"[ERROR] Fallback extraction also failed: {fallback_err}")
            raise
