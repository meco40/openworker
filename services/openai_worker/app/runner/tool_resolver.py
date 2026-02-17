from typing import Any

from app.tools import get_enabled_tool_names

from .constants import (
    BROWSER_USE_PRIMARY_TOOL,
    LEGACY_BROWSER_TOOL_NAMES,
    TOOL_DEFINITIONS,
)


class ToolResolver:
    """Resolves enabled tools and builds tool definitions."""

    @staticmethod
    def resolve_tools(enabled_tools: list[str] | None) -> tuple[str, ...]:
        """Resolve the list of enabled tools.
        
        Filters the allowlist and handles browser tool priorities.
        """
        tool_allowlist = {
            tool.strip()
            for tool in (enabled_tools or [])
            if isinstance(tool, str) and tool.strip()
        }
        resolved = list(get_enabled_tool_names(allowlist=tool_allowlist))
        if BROWSER_USE_PRIMARY_TOOL in resolved:
            resolved = [name for name in resolved if name not in LEGACY_BROWSER_TOOL_NAMES]
        return tuple(resolved)

    @staticmethod
    def build_tool_definitions(resolved_tools: tuple[str, ...]) -> list[dict[str, Any]]:
        """Build the tool definitions for the resolved tools."""
        return [TOOL_DEFINITIONS[name] for name in resolved_tools if name in TOOL_DEFINITIONS]
