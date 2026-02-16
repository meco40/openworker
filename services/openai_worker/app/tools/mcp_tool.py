from typing import Any

TOOL_NAME = "safe_mcp"


class MCPTool:
    name = TOOL_NAME

    def __init__(self, allowed_servers: set[str] | None = None) -> None:
        self._allowed_servers = set(allowed_servers or set())

    def call(self, server: str, action: str, payload: dict[str, Any]) -> dict[str, Any]:
        if server not in self._allowed_servers:
            raise PermissionError(f"server {server} is not allowed")
        if not action.strip():
            raise ValueError("action is required")
        return {
            "status": "ok",
            "tool": self.name,
            "server": server,
            "action": action.strip(),
            "payload": dict(payload),
        }
