"""Benny API - FastAPI endpoints.

Submodules are imported on demand, not eagerly. Every consumer in the
codebase reaches into a specific submodule (``benny.api.server``,
``benny.api.studio_executor``, etc.) — no caller depends on
``benny.api.app`` / ``benny.api.llm_router`` / ``benny.api.workflow_router``
existing at the package level. Eager imports here previously forced the
entire LLM + LangChain dependency stack to load before any single submodule
was usable, which made testing isolated route modules (e.g.
``benny.api.agent_scope`` per ADR-001) impossible without installing every
runtime dep.
"""
