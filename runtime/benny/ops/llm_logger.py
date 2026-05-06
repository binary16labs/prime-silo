"""
Structured LLM Call Logging (LC-6).
"""
import logging
import logging.handlers
import os
import json
from pathlib import Path
from typing import Optional

# Configuration
MAX_BYTES = 50 * 1024 * 1024  # 50MB
BACKUP_COUNT = 5

_logger: Optional[logging.Logger] = None

def get_log_path() -> Path:
    """Determine where to write llm_calls.jsonl."""
    benny_home = os.environ.get("BENNY_HOME")
    if not benny_home:
        # Fallback for dev/unconfigured environments
        benny_home = os.path.abspath(".")
    
    log_dir = Path(benny_home) / "logs"
    if not log_dir.exists():
        log_dir.mkdir(parents=True, exist_ok=True)
    
    return log_dir / "llm_calls.jsonl"

def get_logger() -> logging.Logger:
    """Retrieve or initialize the structured LLM logger."""
    global _logger
    if _logger is not None:
        return _logger
    
    logger = logging.getLogger("benny.llm_calls")
    logger.setLevel(logging.INFO)
    logger.propagate = False  # Don't send to root logger
    
    # Remove existing handlers if any (to avoid duplicates on reload)
    for handler in logger.handlers[:]:
        logger.removeHandler(handler)
    
    log_path = get_log_path()
    handler = logging.handlers.RotatingFileHandler(
        filename=log_path,
        maxBytes=MAX_BYTES,
        backupCount=BACKUP_COUNT,
        encoding="utf-8"
    )
    
    # We don't use a standard Formatter because we want to write raw JSONL
    # But we can use a simple one that just outputs the message
    formatter = logging.Formatter("%(message)s")
    handler.setFormatter(formatter)
    
    logger.addHandler(handler)
    _logger = logger
    return _logger

def log_llm_call(data: dict):
    """Log a single LLM call as a JSON line."""
    logger = get_logger()
    logger.info(json.dumps(data))
