from typing import Any
import json
import os

import httpx

TOOL_NAME = "safe_mcp"
SERVER_URLS_ENV = "OPENAI_WORKER_MCP_SERVER_URLS"
DEFAULT_TIMEOUT_SEC = 20.0


class MCPTool:
    name = TOOL_NAME

    def __init__(
        self,
        allowed_servers: set[str] | None = None,
        server_urls: dict[str, str] | None = None,
        timeout_seconds: float | None = None,
    ) -> None:
        self._allowed_servers = set(allowed_servers or set())
        self._server_urls = server_urls or self._load_server_urls_from_env()
        raw_timeout = timeout_seconds if timeout_seconds is not None else float(
            os.getenv("OPENAI_WORKER_MCP_TIMEOUT_SEC", str(DEFAULT_TIMEOUT_SEC))
        )
        self._timeout_seconds = max(0.5, float(raw_timeout))

    @staticmethod
    def _load_server_urls_from_env() -> dict[str, str]:
        raw = os.getenv(SERVER_URLS_ENV, "").strip()
        if not raw:
            return {}
        try:
            parsed = json.loads(raw)
        except Exception:
            return {}
        if not isinstance(parsed, dict):
            return {}
        output: dict[str, str] = {}
        for key, value in parsed.items():
            server = str(key).strip()
            url = str(value).strip() if isinstance(value, str) else ""
            if server and url:
                output[server] = url
        return output

    def call(self, server: str, action: str, payload: dict[str, Any]) -> dict[str, Any]:
        if server not in self._allowed_servers:
            raise PermissionError(f"server {server} is not allowed")
        if not action.strip():
            raise ValueError("action is required")
        target_url = str(self._server_urls.get(server, "")).strip()
        if not target_url:
            raise RuntimeError(f"no endpoint configured for MCP server: {server}")

        body = {"action": action.strip(), "payload": dict(payload)}
        try:
            response = httpx.post(
                target_url,
                json=body,
                timeout=self._timeout_seconds,
            )
        except Exception as exc:
            raise RuntimeError(f"mcp server request failed: {exc}") from exc

        if response.status_code >= 400:
            raise RuntimeError(f"mcp server {server} responded with status {response.status_code}")

        parsed_response: Any
        try:
            parsed_response = response.json()
        except Exception:
            parsed_response = {"raw": response.text}

        return {
            "status": "ok",
            "tool": self.name,
            "server": server,
            "action": action.strip(),
            "response": parsed_response,
        }
