TOOL_NAME = "safe_browser"


class BrowserTool:
    name = TOOL_NAME

    def execute(self, action: str, url: str | None = None) -> dict[str, str]:
        cleaned = action.strip()
        if not cleaned:
            raise ValueError("action is required")
        return {
            "status": "ok",
            "tool": self.name,
            "action": cleaned,
            "url": url or "",
        }
