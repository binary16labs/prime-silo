"""Portable Benny — the $BENNY_HOME layout, config, and lifecycle.

Public entry points:
- ``benny.portable.home.init(root, profile)`` — create/refresh the layout.
- ``benny.portable.home.validate(root)`` — FR-1 structural check.
- ``benny.portable.home.uninstall(root, keep_data)`` — remove app boundary.
- ``benny.portable.config.load(root)`` — load config, refuse out-of-root paths.
"""

__all__ = ["home", "config"]
