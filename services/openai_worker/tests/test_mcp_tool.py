import pytest

from app.tools.mcp_tool import MCPTool


def test_mcp_tool_rejects_server_outside_allowlist() -> None:
    tool = MCPTool(allowed_servers={"trusted-mcp"})

    with pytest.raises(PermissionError):
        tool.call(server="untrusted-mcp", action="ping", payload={})


def test_mcp_tool_allows_configured_server() -> None:
    tool = MCPTool(allowed_servers={"trusted-mcp"})

    result = tool.call(
        server="trusted-mcp",
        action="ping",
        payload={"message": "ok"},
    )

    assert result["status"] == "ok"
    assert result["server"] == "trusted-mcp"
    assert result["action"] == "ping"
