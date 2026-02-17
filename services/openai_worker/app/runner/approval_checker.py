import json
import re
from typing import Any

from app.tools.browser_tool import BrowserTool
from app.tools.browser_use_tool import BrowserUseTool
from app.tools.computer_use_tool import ComputerUseTool

from .constants import (
    RISKY_GITHUB_ACTIONS,
    RISKY_MCP_ACTION_PATTERN,
    RISKY_SHELL_PATTERN,
)


class ApprovalChecker:
    """Checks if tool calls require approval based on risk assessment."""

    @staticmethod
    def is_risky_tool_call(name: str, args: dict[str, Any]) -> str | None:
        """Check if a tool call is risky and requires approval.
        
        Returns an approval prompt string if risky, None otherwise.
        """
        if name == "safe_shell":
            command = str(args.get("command") or "")
            if RISKY_SHELL_PATTERN.search(command):
                return f"Approve risky shell command?\n\nTool: {name}\nCommand: {command}"
            return None

        if name == "safe_computer_use":
            action = str(args.get("action") or "")
            if ComputerUseTool.is_destructive(action):
                return f"Approve destructive computer-use action?\n\nTool: {name}\nAction: {action}"
            return None

        if name == "safe_browser_use":
            task = str(args.get("task") or "").strip()
            reason = BrowserUseTool.approval_reason(task=task, use_cloud=args.get("use_cloud"))
            if reason:
                return f"Approve browser-use action?\n\nTool: {name}\nReason: {reason}\nTask: {task}"
            return None

        if name == "safe_github":
            action = str(args.get("action") or "").strip().lower()
            if action in RISKY_GITHUB_ACTIONS:
                return f"Approve risky GitHub action?\n\nTool: {name}\nAction: {action}"
            return None

        if name == "safe_mcp":
            action = str(args.get("action") or "")
            if RISKY_MCP_ACTION_PATTERN.search(action):
                return f"Approve risky MCP action?\n\nTool: {name}\nAction: {action}"
            return None

        return None

    @staticmethod
    def format_tool_message(
        name: str,
        args: dict[str, Any],
        result: dict[str, Any] | None = None,
        error: str | None = None,
    ) -> str:
        """Format a tool result as a message."""
        payload: dict[str, Any] = {"tool": name, "args": args}
        if result is not None:
            payload["result"] = result
        if error is not None:
            payload["error"] = error
        return f"TOOL_RESULT {json.dumps(payload, ensure_ascii=False)}"

    @staticmethod
    def parse_function_call(raw_call: dict[str, Any]) -> tuple[str, dict[str, Any]]:
        """Parse a function call from the raw payload."""
        name = str(raw_call.get("name") or "").strip()
        args = raw_call.get("args")
        if isinstance(args, dict):
            return name, dict(args)
        if isinstance(args, str):
            try:
                parsed = json.loads(args)
                if isinstance(parsed, dict):
                    return name, parsed
            except Exception:
                return name, {"raw": args}
        return name, {}
