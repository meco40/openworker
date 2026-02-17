import pytest

from app.tools.browser_use_tool import BrowserUseTool


def test_browser_use_tool_requires_enable_flag() -> None:
    tool = BrowserUseTool(enabled=False)

    with pytest.raises(RuntimeError, match="disabled"):
        tool.execute(action="run_task", task="Open example.com")


def test_browser_use_tool_requires_task_for_run_actions() -> None:
    tool = BrowserUseTool(enabled=True)

    with pytest.raises(ValueError, match="task is required"):
        tool.execute(action="run_task")


def test_browser_use_tool_handles_missing_dependency(monkeypatch: pytest.MonkeyPatch) -> None:
    tool = BrowserUseTool(enabled=True)

    monkeypatch.setattr(tool, "_load_runtime", lambda: (_ for _ in ()).throw(ImportError("missing")))

    with pytest.raises(RuntimeError, match="browser-use"):
        tool.execute(action="run_task", task="Open example.com")


def test_browser_use_tool_runs_task_and_returns_result(monkeypatch: pytest.MonkeyPatch) -> None:
    tool = BrowserUseTool(enabled=True)
    captured: dict[str, object] = {}

    class FakeHistory:
        @staticmethod
        def final_result() -> str:
            return "done"

    class FakeBrowser:
        last_kwargs: dict[str, object] | None = None
        closed = False

        def __init__(self, **kwargs: object) -> None:
            FakeBrowser.last_kwargs = kwargs

        async def close(self) -> None:
            FakeBrowser.closed = True

    class FakeChatBrowserUse:
        pass

    class FakeAgent:
        def __init__(self, task: str, llm: object, browser: object | None = None) -> None:
            captured["task"] = task
            captured["browser"] = browser
            captured["llm"] = llm

        async def run(self, **kwargs: object) -> FakeHistory:
            captured["run_kwargs"] = kwargs
            return FakeHistory()

    monkeypatch.setattr(tool, "_load_runtime", lambda: (FakeAgent, FakeBrowser, FakeChatBrowserUse))

    result = tool.execute(
        action="run_task",
        task="Open example.com and summarize",
        max_steps=7,
        headless=False,
        use_cloud=False,
    )

    assert result["status"] == "ok"
    assert result["tool"] == "safe_browser_use"
    assert result["action"] == "run_task"
    assert result["result"] == "done"
    assert captured["task"] == "Open example.com and summarize"
    assert isinstance(captured["llm"], FakeChatBrowserUse)
    assert captured["run_kwargs"] == {"max_steps": 7}
    assert FakeBrowser.last_kwargs == {"headless": False, "use_cloud": False}
    assert FakeBrowser.closed is True


def test_browser_use_tool_requires_approval_for_risky_task() -> None:
    tool = BrowserUseTool(enabled=True)

    with pytest.raises(PermissionError, match="approval is required"):
        tool.execute(action="run_task", task="Delete all files in C:/Users")


def test_browser_use_tool_allows_risky_task_when_approved(monkeypatch: pytest.MonkeyPatch) -> None:
    tool = BrowserUseTool(enabled=True)

    class FakeHistory:
        @staticmethod
        def final_result() -> str:
            return "done"

    class FakeChatBrowserUse:
        pass

    class FakeAgent:
        def __init__(self, task: str, llm: object, browser: object | None = None) -> None:
            _ = (task, llm, browser)

        async def run(self, **kwargs: object) -> FakeHistory:
            _ = kwargs
            return FakeHistory()

    monkeypatch.setattr(tool, "_load_runtime", lambda: (FakeAgent, None, FakeChatBrowserUse))

    result = tool.execute(
        action="run_task",
        task="Delete stale test files in temp folder",
        approved=True,
    )

    assert result["status"] == "ok"
    assert result["result"] == "done"
