from typing import Any

from app.tools.browser_tool import BrowserTool
from app.tools.browser_use_tool import BrowserUseTool
from app.tools.computer_use_tool import ComputerUseTool
from app.tools.files_tool import FilesTool
from app.tools.github_tool import GitHubTool
from app.tools.mcp_tool import MCPTool
from app.tools.shell_tool import ShellTool

from .constants import get_allowed_mcp_servers


class ToolExecutor:
    """Executes tool calls based on resolved tools and approval status."""

    def execute_tool_call(
        self,
        *,
        name: str,
        args: dict[str, Any],
        resolved_tools: tuple[str, ...],
        approved: bool,
    ) -> dict[str, Any]:
        """Execute a single tool call."""
        if name not in resolved_tools:
            raise PermissionError(f"tool {name} is not enabled for this run")

        if name == "safe_shell":
            return ShellTool().execute(command=str(args.get("command") or ""))
        
        if name == "safe_browser":
            return BrowserTool().execute(
                action=str(args.get("action") or ""),
                url=str(args.get("url") or "").strip() or None,
                max_links=int(args.get("max_links")) if isinstance(args.get("max_links"), int) else None,
            )
        
        if name == "safe_browser_use":
            return BrowserUseTool(enabled=True).execute(
                action=str(args.get("action") or ""),
                task=str(args.get("task") or "").strip() or None,
                max_steps=args.get("max_steps"),
                headless=args.get("headless"),
                use_cloud=args.get("use_cloud"),
                approved=approved,
            )
        
        if name == "safe_files":
            return FilesTool().execute(
                operation=str(args.get("operation") or ""),
                path=str(args.get("path") or ""),
                content=str(args.get("content") or "") if args.get("content") is not None else None,
            )
        
        if name == "safe_github":
            extra_args = dict(args)
            extra_args.pop("action", None)
            extra_args.pop("owner", None)
            extra_args.pop("repo", None)
            return GitHubTool().execute(
                action=str(args.get("action") or ""),
                owner=str(args.get("owner") or ""),
                repo=str(args.get("repo") or ""),
                **extra_args,
            )
        
        if name == "safe_mcp":
            payload = args.get("payload")
            return MCPTool(allowed_servers=get_allowed_mcp_servers()).call(
                server=str(args.get("server") or ""),
                action=str(args.get("action") or ""),
                payload=payload if isinstance(payload, dict) else {},
            )
        
        if name == "safe_computer_use":
            extra_args = dict(args)
            extra_args.pop("action", None)
            return ComputerUseTool(enabled=True).perform(
                action=str(args.get("action") or ""),
                approved=approved,
                **extra_args,
            )

        raise ValueError(f"unsupported tool call: {name}")
