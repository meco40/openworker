from typing import Any

from .constants import (
    DEFAULT_TOOL_APPROVAL_MODE,
    LEGACY_TOOL_APPROVAL_MODE,
    TOOL_APPROVAL_MODES,
)


class ToolPolicy:
    """Manages tool approval policies."""

    @staticmethod
    def normalize(
        tool_approval_policy: dict[str, Any] | None,
        resolved_tools: tuple[str, ...],
    ) -> tuple[str, dict[str, str]]:
        """Normalize the tool approval policy.
        
        Returns a tuple of (default_mode, mode_by_tool_name).
        """
        if not isinstance(tool_approval_policy, dict):
            return LEGACY_TOOL_APPROVAL_MODE, {
                tool_name: LEGACY_TOOL_APPROVAL_MODE for tool_name in resolved_tools
            }

        default_mode = DEFAULT_TOOL_APPROVAL_MODE
        by_name: dict[str, str] = {}
        
        raw_default = tool_approval_policy.get("defaultMode")
        if isinstance(raw_default, str):
            cleaned_default = raw_default.strip().lower()
            if cleaned_default in TOOL_APPROVAL_MODES:
                default_mode = cleaned_default

        raw_by_name = tool_approval_policy.get("byFunctionName")
        if isinstance(raw_by_name, dict):
            for key, value in raw_by_name.items():
                if not isinstance(key, str) or not isinstance(value, str):
                    continue
                cleaned_name = key.strip()
                cleaned_mode = value.strip().lower()
                if not cleaned_name or cleaned_mode not in TOOL_APPROVAL_MODES:
                    continue
                by_name[cleaned_name] = cleaned_mode

        normalized = {
            tool_name: by_name.get(tool_name, default_mode) for tool_name in resolved_tools
        }
        return default_mode, normalized
