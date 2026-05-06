"""AOS-001 Phase 2 — Progressive disclosure registry (AOS-F8, AOS-F9, AOS-F10).

Three-layer context loading for tools, keeping the LLM context lean:

  Layer 1  (always present)  — tool_name + one-line summary (~4 tokens/entry)
  Layer 2  (on activate())   — full JSON Schema, lazy-loaded and cached
  Layer 3  (on examples())   — usage examples + docs artefact ref; never auto-loaded

The full Layer 1 index for all registered tools MUST fit in ≤ 500 tokens
(AOS-NFR12).  Entries are kept minimal: tool_name ≤ 50 chars, summary ≤ 80 chars.
"""

from __future__ import annotations

from typing import Any, Callable, Dict, List, Optional


class _DisclosureEntry:
    """Internal record for one tool in the registry."""

    __slots__ = (
        "tool_name",
        "summary",
        "_schema",
        "_schema_factory",
        "_schema_cached",
        "_examples",
        "_examples_factory",
        "_examples_cached",
        "docs_uri",
    )

    def __init__(
        self,
        tool_name: str,
        summary: str,
        *,
        schema: Optional[Dict[str, Any]] = None,
        schema_factory: Optional[Callable[[], Dict[str, Any]]] = None,
        examples: Optional[Any] = None,
        examples_factory: Optional[Callable[[], Dict[str, Any]]] = None,
        docs_uri: Optional[str] = None,
    ) -> None:
        self.tool_name = tool_name
        self.summary = summary[:80]          # hard clamp for budget safety
        self._schema: Optional[Dict[str, Any]] = schema
        self._schema_factory = schema_factory
        self._schema_cached: Optional[Dict[str, Any]] = None
        # Layer 3 — stored but never auto-loaded
        self._examples = examples
        self._examples_factory = examples_factory
        self._examples_cached: Optional[Dict[str, Any]] = None
        self.docs_uri = docs_uri

    # ------------------------------------------------------------------
    # Layer 2
    # ------------------------------------------------------------------

    def get_schema(self) -> Dict[str, Any]:
        """Return layer2 JSON Schema, invoking the factory once if needed."""
        if self._schema_cached is not None:
            return self._schema_cached
        if self._schema_factory is not None:
            self._schema_cached = self._schema_factory()
            return self._schema_cached
        if self._schema is not None:
            self._schema_cached = self._schema
            return self._schema_cached
        return {}

    # ------------------------------------------------------------------
    # Layer 3
    # ------------------------------------------------------------------

    def get_examples(self) -> Dict[str, Any]:
        """Return layer3 payload, invoking the factory once if needed."""
        if self._examples_cached is not None:
            return self._examples_cached
        if self._examples_factory is not None:
            self._examples_cached = self._examples_factory()
            return self._examples_cached
        if self._examples is not None:
            payload: Dict[str, Any] = {}
            if isinstance(self._examples, list):
                payload["examples"] = self._examples
            else:
                payload["examples"] = [self._examples]
            if self.docs_uri:
                payload["docs_uri"] = self.docs_uri
            self._examples_cached = payload
            return self._examples_cached
        return {}


class DisclosureRegistry:
    """Maps tool names to their three-layer disclosure records."""

    def __init__(self) -> None:
        self._entries: Dict[str, _DisclosureEntry] = {}

    def register(
        self,
        tool_name: str,
        summary: str,
        *,
        schema: Optional[Dict[str, Any]] = None,
        schema_factory: Optional[Callable[[], Dict[str, Any]]] = None,
        examples: Optional[Any] = None,
        examples_factory: Optional[Callable[[], Dict[str, Any]]] = None,
        docs_uri: Optional[str] = None,
    ) -> None:
        """Register *tool_name* with its three disclosure layers.

        *schema_factory* and *examples_factory* are callables invoked lazily
        the first time activate() / examples() is called.  Neither factory is
        called at registration time (AOS-F9, AOS-F10).
        """
        self._entries[tool_name] = _DisclosureEntry(
            tool_name,
            summary,
            schema=schema,
            schema_factory=schema_factory,
            examples=examples,
            examples_factory=examples_factory,
            docs_uri=docs_uri,
        )

    def layer1_index(self) -> List[Dict[str, str]]:
        """Return Layer 1 for every registered tool.

        Each entry has exactly two keys: ``tool_name`` and ``summary``.
        The complete serialised index MUST remain ≤ 500 tokens (AOS-F8 / NFR12).
        """
        return [
            {"tool_name": e.tool_name, "summary": e.summary}
            for e in self._entries.values()
        ]

    def activate(self, tool_name: str) -> Dict[str, Any]:
        """Return the Layer 2 JSON Schema for *tool_name*.

        Lazy-loads and caches on first call (AOS-F9).

        Raises:
            KeyError: if *tool_name* is not registered.
        """
        if tool_name not in self._entries:
            raise KeyError(f"Tool not registered in disclosure registry: {tool_name!r}")
        return self._entries[tool_name].get_schema()

    def examples(self, tool_name: str) -> Dict[str, Any]:
        """Return the Layer 3 payload for *tool_name*.

        Never called automatically — only when the agent explicitly requests
        examples (AOS-F10).

        Raises:
            KeyError: if *tool_name* is not registered.
        """
        if tool_name not in self._entries:
            raise KeyError(f"Tool not registered in disclosure registry: {tool_name!r}")
        return self._entries[tool_name].get_examples()

    def __contains__(self, tool_name: str) -> bool:
        return tool_name in self._entries

    def __len__(self) -> int:
        return len(self._entries)


# ---------------------------------------------------------------------------
# Module-level singleton (AOS-F8 — ships with Benny)
# ---------------------------------------------------------------------------

registry = DisclosureRegistry()
