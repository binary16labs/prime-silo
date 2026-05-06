"""
Benny Governance - Phoenix distributed tracing integration
Provides observability for LLM calls and workflow execution
"""

import os
from typing import Optional, Dict, Any
from contextlib import contextmanager
import functools

# Phoenix tracing imports
try:
    from phoenix.otel import register
    from opentelemetry import trace
    from opentelemetry.trace import Status, StatusCode
    PHOENIX_AVAILABLE = True
except ImportError:
    PHOENIX_AVAILABLE = False


# =============================================================================
# CONFIGURATION
# =============================================================================

PHOENIX_URL = os.getenv("PHOENIX_URL", "http://localhost:6006")
SERVICE_NAME = os.getenv("SERVICE_NAME", "benny")


# =============================================================================
# TRACER SETUP
# =============================================================================

_tracer: Optional[Any] = None


def init_tracing(
    phoenix_url: str = PHOENIX_URL,
    service_name: str = SERVICE_NAME
) -> bool:
    """
    Initialize Phoenix tracing.
    Returns True if successful, False if Phoenix is not available.
    """
    global _tracer
    
    if not PHOENIX_AVAILABLE:
        print("Phoenix tracing not available - install arize-phoenix")
        return False
    
    try:
        # Register with Phoenix
        register(
            endpoint=f"{phoenix_url}/v1/traces",
            project_name=service_name
        )
        
        _tracer = trace.get_tracer(service_name)
        return True
    except Exception as e:
        print(f"Failed to initialize Phoenix tracing: {e}")
        return False


def get_tracer():
    """Get the configured tracer, or None if not initialized"""
    return _tracer


# =============================================================================
# TRACING DECORATORS
# =============================================================================

def trace_llm_call(model: str, provider: str):
    """
    Decorator to trace LLM calls with Phoenix.
    Captures model, provider, tokens, and response metadata.
    """
    def decorator(func):
        @functools.wraps(func)
        async def async_wrapper(*args, **kwargs):
            if not _tracer:
                return await func(*args, **kwargs)
            
            with _tracer.start_as_current_span(f"llm.{provider}.{model}") as span:
                span.set_attribute("llm.model", model)
                span.set_attribute("llm.provider", provider)
                span.set_attribute("llm.temperature", kwargs.get("temperature", 0.7))
                
                try:
                    result = await func(*args, **kwargs)
                    
                    # Extract usage if available
                    if hasattr(result, "usage") and result.usage:
                        span.set_attribute("llm.prompt_tokens", result.usage.prompt_tokens)
                        span.set_attribute("llm.completion_tokens", result.usage.completion_tokens)
                        span.set_attribute("llm.total_tokens", result.usage.total_tokens)
                    
                    span.set_status(Status(StatusCode.OK))
                    return result
                except Exception as e:
                    span.set_status(Status(StatusCode.ERROR, str(e)))
                    span.record_exception(e)
                    raise
        
        @functools.wraps(func)
        def sync_wrapper(*args, **kwargs):
            if not _tracer:
                return func(*args, **kwargs)
            
            with _tracer.start_as_current_span(f"llm.{provider}.{model}") as span:
                span.set_attribute("llm.model", model)
                span.set_attribute("llm.provider", provider)
                
                try:
                    result = func(*args, **kwargs)
                    span.set_status(Status(StatusCode.OK))
                    return result
                except Exception as e:
                    span.set_status(Status(StatusCode.ERROR, str(e)))
                    span.record_exception(e)
                    raise
        
        import asyncio
        if asyncio.iscoroutinefunction(func):
            return async_wrapper
        return sync_wrapper
    return decorator


def trace_tool_execution(tool_name: str):
    """
    Decorator to trace tool executions with Phoenix.
    Captures tool name, arguments, and result status.
    """
    def decorator(func):
        @functools.wraps(func)
        def wrapper(*args, **kwargs):
            if not _tracer:
                return func(*args, **kwargs)
            
            with _tracer.start_as_current_span(f"tool.{tool_name}") as span:
                span.set_attribute("tool.name", tool_name)
                span.set_attribute("tool.args", str(kwargs))
                
                try:
                    result = func(*args, **kwargs)
                    span.set_attribute("tool.success", True)
                    span.set_status(Status(StatusCode.OK))
                    return result
                except Exception as e:
                    span.set_attribute("tool.success", False)
                    span.set_attribute("tool.error", str(e))
                    span.set_status(Status(StatusCode.ERROR, str(e)))
                    span.record_exception(e)
                    raise
        return wrapper
    return decorator


def trace_workflow(workflow_name: str):
    """
    Decorator to trace entire workflow execution.
    Creates a parent span for the workflow.
    """
    def decorator(func):
        @functools.wraps(func)
        async def async_wrapper(*args, **kwargs):
            if not _tracer:
                return await func(*args, **kwargs)
            
            with _tracer.start_as_current_span(f"workflow.{workflow_name}") as span:
                span.set_attribute("workflow.name", workflow_name)
                span.set_attribute("workflow.workspace", kwargs.get("workspace", "default"))
                
                try:
                    result = await func(*args, **kwargs)
                    span.set_status(Status(StatusCode.OK))
                    return result
                except Exception as e:
                    span.set_status(Status(StatusCode.ERROR, str(e)))
                    span.record_exception(e)
                    raise
        
        @functools.wraps(func)
        def sync_wrapper(*args, **kwargs):
            if not _tracer:
                return func(*args, **kwargs)
            
            with _tracer.start_as_current_span(f"workflow.{workflow_name}") as span:
                span.set_attribute("workflow.name", workflow_name)
                
                try:
                    result = func(*args, **kwargs)
                    span.set_status(Status(StatusCode.OK))
                    return result
                except Exception as e:
                    span.set_status(Status(StatusCode.ERROR, str(e)))
                    span.record_exception(e)
                    raise
        
        import asyncio
        if asyncio.iscoroutinefunction(func):
            return async_wrapper
        return sync_wrapper
    return decorator


# =============================================================================
# CONTEXT MANAGERS
# =============================================================================

@contextmanager
def trace_span(name: str, attributes: Optional[Dict[str, Any]] = None):
    """
    Context manager for creating custom trace spans.
    
    Usage:
        with trace_span("my_operation", {"key": "value"}) as span:
            # do work
            span.set_attribute("result", "success")
    """
    if not _tracer:
        yield None
        return
    
    with _tracer.start_as_current_span(name) as span:
        if attributes:
            for key, value in attributes.items():
                span.set_attribute(key, value)
        
        try:
            yield span
            span.set_status(Status(StatusCode.OK))
        except Exception as e:
            span.set_status(Status(StatusCode.ERROR, str(e)))
            span.record_exception(e)
            raise


# =============================================================================
# W3C TRACE CONTEXT
# =============================================================================

def get_trace_context() -> Dict[str, str]:
    """
    Get W3C trace context headers for propagation.
    Useful for passing trace context to external services.
    """
    if not _tracer:
        return {}
    
    from opentelemetry import propagate
    from opentelemetry.propagators.textmap import CarrierT
    
    carrier: Dict[str, str] = {}
    propagate.inject(carrier)
    return carrier


def set_trace_context(headers: Dict[str, str]) -> None:
    """
    Set trace context from incoming headers.
    Useful for continuing traces from external services.
    """
    if not _tracer:
        return
    
    from opentelemetry import propagate
    propagate.extract(headers)
