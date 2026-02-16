import time
from typing import Any

from app.tools.browser_tool import BrowserTool

TOOL_NAME = "safe_computer_use"

DESTRUCTIVE_ACTIONS = {
    "delete",
    "delete_file",
    "format",
    "shutdown",
}


class ComputerUseTool:
    name = TOOL_NAME

    def __init__(self, enabled: bool, browser_tool: BrowserTool | None = None) -> None:
        self._enabled = enabled
        self._browser_tool = browser_tool or BrowserTool()

    @staticmethod
    def is_destructive(action: str) -> bool:
        lowered = action.strip().lower()
        return lowered in DESTRUCTIVE_ACTIONS or lowered.startswith("delete_")

    def perform(self, action: str, approved: bool = False, **kwargs: Any) -> dict[str, Any]:
        cleaned = action.strip()
        if not self._enabled:
            raise RuntimeError("computer use tool is disabled")
        if not cleaned:
            raise ValueError("action is required")
        if self.is_destructive(cleaned) and not approved:
            raise PermissionError("destructive action requires explicit approval")

        lowered = cleaned.lower()
        if lowered == "open_url":
            url = str(kwargs.get("url") or "").strip()
            if not url:
                raise ValueError("url is required for open_url")
            browser_result = self._browser_tool.execute(action="fetch", url=url)
            return {
                "status": "ok",
                "tool": self.name,
                "action": cleaned,
                "browser": browser_result,
            }

        if lowered == "extract_links":
            url = str(kwargs.get("url") or "").strip()
            if not url:
                raise ValueError("url is required for extract_links")
            browser_result = self._browser_tool.execute(action="extract_links", url=url)
            return {
                "status": "ok",
                "tool": self.name,
                "action": cleaned,
                "browser": browser_result,
            }

        if lowered == "wait":
            seconds_raw = kwargs.get("seconds")
            seconds = float(seconds_raw) if isinstance(seconds_raw, (float, int, str)) else 1.0
            seconds = max(0.0, min(seconds, 10.0))
            time.sleep(seconds)
            return {
                "status": "ok",
                "tool": self.name,
                "action": cleaned,
                "seconds": seconds,
            }

        return {
            "status": "ok",
            "tool": self.name,
            "action": cleaned,
        }
