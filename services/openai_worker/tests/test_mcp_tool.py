import pytest
import httpx

from app.tools.mcp_tool import MCPTool


def test_mcp_tool_rejects_server_outside_allowlist() -> None:
    tool = MCPTool(allowed_servers={"trusted-mcp"})

    with pytest.raises(PermissionError):
        tool.call(server="untrusted-mcp", action="ping", payload={})


def test_mcp_tool_allows_configured_server() -> None:
    def fake_post(url: str, *, json: dict[str, object], timeout: float) -> httpx.Response:
        request = httpx.Request("POST", url)
        return httpx.Response(200, request=request, json={"ok": True, "echo": json})

    original_post = httpx.post
    httpx.post = fake_post
    tool = MCPTool(
        allowed_servers={"trusted-mcp"},
        server_urls={"trusted-mcp": "http://127.0.0.1:8999/mcp"},
    )

    try:
        result = tool.call(
            server="trusted-mcp",
            action="ping",
            payload={"message": "ok"},
        )
    finally:
        httpx.post = original_post

    assert result["status"] == "ok"
    assert result["server"] == "trusted-mcp"
    assert result["action"] == "ping"
    assert result["response"] == {"ok": True, "echo": {"action": "ping", "payload": {"message": "ok"}}}


def test_mcp_tool_requires_server_url_mapping() -> None:
    tool = MCPTool(allowed_servers={"trusted-mcp"}, server_urls={})

    with pytest.raises(RuntimeError):
        tool.call(server="trusted-mcp", action="ping", payload={})


def test_mcp_tool_posts_to_configured_server(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, object] = {}

    def fake_post(url: str, *, json: dict[str, object], timeout: float) -> httpx.Response:
        captured["url"] = url
        captured["json"] = json
        request = httpx.Request("POST", url)
        return httpx.Response(
            200,
            request=request,
            json={"ok": True, "echo": json},
        )

    monkeypatch.setattr(httpx, "post", fake_post)
    tool = MCPTool(
        allowed_servers={"trusted-mcp"},
        server_urls={"trusted-mcp": "http://127.0.0.1:8999/mcp"},
    )

    result = tool.call(server="trusted-mcp", action="ping", payload={"x": 1})

    assert result["status"] == "ok"
    assert result["server"] == "trusted-mcp"
    assert result["response"] == {"ok": True, "echo": {"action": "ping", "payload": {"x": 1}}}
    assert captured["url"] == "http://127.0.0.1:8999/mcp"
