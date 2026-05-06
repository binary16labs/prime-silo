"""
AER (Audit Execution Record) Decorators - Automatic tool-level timing and governance tracking.

Provides @aer_tracked decorator for async functions and @aer_tracked_sync for synchronous functions.
Automatically emits NODE_EXECUTION_STATE events with timing data to the governance audit trail.
"""

import functools
import logging
import time
import uuid
from typing import Callable, Optional, Any

from .execution_audit import emit_node_execution_state

logger = logging.getLogger(__name__)


def _resolve_workspace(args, kwargs, workspace_resolver=None) -> str:
    """Extract workspace from function args/kwargs."""
    if workspace_resolver:
        return workspace_resolver(args, kwargs)
    # Try common patterns
    if "workspace" in kwargs:
        return kwargs["workspace"]
    # First positional arg is often workspace
    if args and isinstance(args[0], str):
        return args[0]
    return "default"


def aer_tracked(tool_name: str, workspace_resolver: Callable = None):
    """
    Decorator for async functions that automatically tracks execution in the AER audit trail.

    Emits:
      - NODE_EXECUTION_STATE(status='started') on entry
      - NODE_EXECUTION_STATE(status='completed', duration_ms=X) on success
      - NODE_EXECUTION_STATE(status='failed', error=X, duration_ms=X) on exception

    Args:
        tool_name: Identifier for this tool in the audit trail (e.g., 'safe_correlation')
        workspace_resolver: Optional callable(args, kwargs) -> str to extract workspace

    Usage:
        @aer_tracked("safe_correlation")
        async def run_safe_correlation(workspace: str):
            ...
    """
    def decorator(func):
        @functools.wraps(func)
        async def wrapper(*args, **kwargs):
            exec_id = str(uuid.uuid4())
            ws = _resolve_workspace(args, kwargs, workspace_resolver)
            start = time.monotonic()

            emit_node_execution_state(
                execution_id=exec_id,
                workspace_id=ws,
                node_id=tool_name,
                status="started",
                inputs={"args_count": len(args), "kwargs_keys": list(kwargs.keys())}
            )

            try:
                result = await func(*args, **kwargs)
                duration = (time.monotonic() - start) * 1000

                # Build a safe summary of the result, including token counts (C.2.3)
                result_summary = {}
                if result is not None:
                    result_summary["result_type"] = type(result).__name__
                    if isinstance(result, dict):
                        result_summary["keys"] = list(result.keys())[:10]
                        # Extract token usage if present (LiteLLM usage dict)
                        usage = result.get("usage") or result.get("token_usage")
                        if usage:
                            if hasattr(usage, "model_dump"):
                                usage = usage.model_dump()
                            elif not isinstance(usage, dict):
                                usage = dict(usage)
                            result_summary["prompt_tokens"]     = usage.get("prompt_tokens", 0)
                            result_summary["completion_tokens"] = usage.get("completion_tokens", 0)
                            result_summary["total_tokens"]      = usage.get("total_tokens", 0)
                    elif isinstance(result, (int, float)):
                        result_summary["value"] = result
                    elif isinstance(result, (list, tuple)):
                        result_summary["length"] = len(result)

                emit_node_execution_state(
                    execution_id=exec_id,
                    workspace_id=ws,
                    node_id=tool_name,
                    status="completed",
                    outputs=result_summary,
                    duration_ms=duration
                )

                logger.debug(f"AER[{tool_name}]: Completed in {duration:.1f}ms")
                return result

            except Exception as e:
                duration = (time.monotonic() - start) * 1000

                emit_node_execution_state(
                    execution_id=exec_id,
                    workspace_id=ws,
                    node_id=tool_name,
                    status="failed",
                    error=f"{type(e).__name__}: {str(e)}",
                    duration_ms=duration
                )

                logger.warning(f"AER[{tool_name}]: Failed after {duration:.1f}ms - {e}")
                raise

        return wrapper
    return decorator


def aer_tracked_sync(tool_name: str, workspace_resolver: Callable = None):
    """
    Decorator for synchronous functions that automatically tracks execution in the AER audit trail.

    Same behavior as @aer_tracked but for non-async functions.

    Usage:
        @aer_tracked_sync("code_analysis")
        def analyze_workspace(workspace_root: str):
            ...
    """
    def decorator(func):
        @functools.wraps(func)
        def wrapper(*args, **kwargs):
            exec_id = str(uuid.uuid4())
            ws = _resolve_workspace(args, kwargs, workspace_resolver)
            start = time.monotonic()

            emit_node_execution_state(
                execution_id=exec_id,
                workspace_id=ws,
                node_id=tool_name,
                status="started",
                inputs={"args_count": len(args), "kwargs_keys": list(kwargs.keys())}
            )

            try:
                result = func(*args, **kwargs)
                duration = (time.monotonic() - start) * 1000

                result_summary = {}
                if result is not None:
                    result_summary["result_type"] = type(result).__name__
                    if isinstance(result, dict):
                        result_summary["keys"] = list(result.keys())[:10]
                    elif isinstance(result, (int, float)):
                        result_summary["value"] = result

                emit_node_execution_state(
                    execution_id=exec_id,
                    workspace_id=ws,
                    node_id=tool_name,
                    status="completed",
                    outputs=result_summary,
                    duration_ms=duration
                )

                logger.debug(f"AER[{tool_name}]: Completed in {duration:.1f}ms")
                return result

            except Exception as e:
                duration = (time.monotonic() - start) * 1000

                emit_node_execution_state(
                    execution_id=exec_id,
                    workspace_id=ws,
                    node_id=tool_name,
                    status="failed",
                    error=f"{type(e).__name__}: {str(e)}",
                    duration_ms=duration
                )

                logger.warning(f"AER[{tool_name}]: Failed after {duration:.1f}ms - {e}")
                raise

        return wrapper
    return decorator
