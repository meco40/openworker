import pytest

import app.tools.computer_use_tool as computer_use_module
from app.tools.computer_use_tool import ComputerUseTool


def test_computer_use_requires_feature_flag() -> None:
    tool = ComputerUseTool(enabled=False)

    with pytest.raises(RuntimeError):
        tool.perform(action="click")


def test_computer_use_requires_approval_for_destructive_action() -> None:
    tool = ComputerUseTool(enabled=True)

    with pytest.raises(PermissionError):
        tool.perform(action="delete_file")


def test_computer_use_allows_destructive_action_when_approved() -> None:
    tool = ComputerUseTool(enabled=True)

    result = tool.perform(action="delete_file", approved=True)

    assert result["status"] == "ok"
    assert result["action"] == "delete_file"


def test_computer_use_open_url_delegates_to_browser(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, str] = {}

    class FakeBrowserTool:
        def execute(self, action: str, url: str | None = None) -> dict[str, str]:
            captured["action"] = action
            captured["url"] = url or ""
            return {"status": "ok", "tool": "safe_browser", "action": action, "url": url or ""}

    monkeypatch.setattr(computer_use_module, "BrowserTool", FakeBrowserTool)
    tool = ComputerUseTool(enabled=True)

    result = tool.perform(action="open_url", url="https://example.com")

    assert result["status"] == "ok"
    assert result["tool"] == "safe_computer_use"
    assert result["browser"]["tool"] == "safe_browser"
    assert captured["action"] == "fetch"
    assert captured["url"] == "https://example.com"
