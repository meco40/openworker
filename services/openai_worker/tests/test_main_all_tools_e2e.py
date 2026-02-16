from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread

import httpx
from fastapi.testclient import TestClient

import app.main as main_module


HTML_DOC = """
<html>
  <head><title>All Tools E2E</title></head>
  <body><h1>Tool Integration</h1></body>
</html>
""".strip()


class _Handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:  # noqa: N802
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.end_headers()
        self.wfile.write(HTML_DOC.encode("utf-8"))

    def log_message(self, format: str, *args: object) -> None:  # noqa: A003
        return


def test_sidecar_run_executes_all_enabled_tools(tmp_path: Path, monkeypatch) -> None:
    server = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    host, port = server.server_address
    local_url = f"http://{host}:{port}"
    notes_file = tmp_path / "all-tools-notes.txt"

    original_executor = main_module._runner._objective_executor
    main_module._runs.clear()
    main_module._approvals._requests.clear()
    main_module._runner._pending_runs.clear()

    monkeypatch.setenv("OPENAI_WORKER_ALLOWED_MCP_SERVERS", "trusted-mcp")
    monkeypatch.setenv(
        "OPENAI_WORKER_MCP_SERVER_URLS",
        '{"trusted-mcp":"http://127.0.0.1:8999/mcp"}',
    )

    def fake_github_request(method: str, url: str, **kwargs: object) -> httpx.Response:
        request = httpx.Request(method=method, url=url)
        return httpx.Response(200, request=request, json=[{"number": 1, "title": "ok"}])

    def fake_mcp_post(url: str, *, json: dict[str, object], timeout: float) -> httpx.Response:
        request = httpx.Request("POST", url)
        return httpx.Response(200, request=request, json={"ok": True, "echo": json})

    monkeypatch.setattr(httpx, "request", fake_github_request)
    monkeypatch.setattr(httpx, "post", fake_mcp_post)

    call_count = {"value": 0}

    def fake_executor(
        *,
        messages: list[dict[str, str]],
        run_id: str,
        model: str,
        profile_id: str,
        tools: list[dict[str, object]] | None = None,
    ) -> dict[str, object]:
        if call_count["value"] == 0:
            call_count["value"] += 1
            return {
                "text": "",
                "model": "gpt-4o-mini",
                "provider": "openai",
                "functionCalls": [
                    {"name": "safe_shell", "args": {"command": "python -c \"print('ok')\""}},
                    {"name": "safe_browser", "args": {"action": "fetch", "url": local_url}},
                    {
                        "name": "safe_files",
                        "args": {
                            "operation": "write",
                            "path": str(notes_file),
                            "content": "all tools",
                        },
                    },
                    {
                        "name": "safe_github",
                        "args": {"action": "list_issues", "owner": "openclaw", "repo": "clawtest"},
                    },
                    {"name": "safe_mcp", "args": {"server": "trusted-mcp", "action": "ping", "payload": {}}},
                    {"name": "safe_computer_use", "args": {"action": "wait", "seconds": 0}},
                ],
            }

        call_count["value"] += 1
        tool_results = [
            item
            for item in messages
            if item.get("role") == "assistant"
            and str(item.get("content") or "").startswith("TOOL_RESULT ")
        ]
        assert len(tool_results) == 6
        return {
            "text": "all tools e2e completed",
            "model": "gpt-4o-mini",
            "provider": "openai",
            "functionCalls": [],
        }

    main_module._runner._objective_executor = fake_executor

    try:
        client = TestClient(main_module.app)
        response = client.post(
            "/runs/start",
            json={
                "runId": "run-all-tools-e2e",
                "objective": "execute all tools",
                "enabledTools": [
                    "safe_shell",
                    "safe_browser",
                    "safe_files",
                    "safe_github",
                    "safe_mcp",
                    "safe_computer_use",
                ],
            },
        )
        assert response.status_code == 200
        payload = response.json()
        assert payload["status"] == "completed"
        assert "all tools e2e completed" in payload["output"]
        assert notes_file.exists()
        assert notes_file.read_text(encoding="utf-8") == "all tools"
    finally:
        main_module._runner._objective_executor = original_executor
        main_module._runs.clear()
        main_module._approvals._requests.clear()
        main_module._runner._pending_runs.clear()
        server.shutdown()
        server.server_close()
        thread.join(timeout=1)
